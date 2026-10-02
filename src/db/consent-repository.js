import { TenantDatabase } from './tenant.js';

export class ConsentRepository {
  #db;
  #userId;
  constructor(db, verifiedUserId) {
    if (!(db instanceof TenantDatabase)) throw new Error('Tenant database required');
    this.#db = db;
    this.#userId = verifiedUserId;
  }
  #context(hubId) {
    return { hubId, userId: this.#userId, orgIds: [], isStaff: false };
  }
  async list(hubId) {
    return this.#db.withSnapshot(this.#context(hubId), async tx =>
      (await tx.query(`SELECT p.purpose,p.notice_version,p.notice_text,
        coalesce(c.granted AND c.notice_version=p.notice_version,false) AS granted,c.changed_at
        FROM compliance.consent_purposes p
        LEFT JOIN compliance.consents c ON c.hub_id=p.hub_id AND c.purpose=p.purpose
        ORDER BY p.purpose`)).rows);
  }
  async set(hubId, { purpose, granted, noticeVersion }) {
    if (typeof purpose !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(purpose) ||
        typeof granted !== 'boolean' || typeof noticeVersion !== 'string' ||
        noticeVersion.length < 1 || noticeVersion.length > 100) {
      throw Object.assign(new Error('Invalid consent decision'), { status: 400 });
    }
    try{return await this.#db.withSnapshot(this.#context(hubId), async tx => {
      if (granted && !(await tx.query('SELECT app.is_active_member() AS active')).rows[0].active)
        throw Object.assign(new Error('Not found'), { status: 404 });
      const result = await tx.query(`SELECT notice_version FROM compliance.consent_purposes
        WHERE purpose=$1`, [purpose]);
      if (!result.rows.length) throw Object.assign(new Error('Not found'), { status: 404 });
      if (result.rows[0].notice_version !== noticeVersion)
        throw Object.assign(new Error('Consent notice changed'), { status: 409 });
      return (await tx.query(`INSERT INTO compliance.consents
        (hub_id,user_id,purpose,granted,notice_version) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT(hub_id,user_id,purpose) DO UPDATE
        SET granted=excluded.granted,notice_version=excluded.notice_version,changed_at=now()
        RETURNING purpose,granted,notice_version,changed_at`,
      [hubId,this.#userId,purpose,granted,noticeVersion])).rows[0];
    });}catch(error){
      if(['23514','40001','40P01'].includes(error.code))throw Object.assign(new Error('Consent notice changed'),{status:409});
      throw error;
    }
  }
}
