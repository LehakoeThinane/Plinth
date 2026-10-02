import { TenantDatabase } from './tenant.js';
const failure=status=>Object.assign(new Error('Notice publication rejected'),{status});
export class NoticeRepository {
  #db;#userId;
  constructor(database,userId) {if(!(database instanceof TenantDatabase))throw Error('Tenant database required');this.#db=database;this.#userId=userId;}
  async #run(hubId,operation) {
    try {return await this.#db.withSnapshot({hubId,userId:this.#userId,orgIds:[],isStaff:false},async tx=>{
      if(!(await tx.query('SELECT app.is_hub_admin() AS allowed')).rows[0].allowed)throw failure(404);
      return operation(tx);
    });}catch(error){
      if(error.code==='42501')throw failure(404);
      if(['23505','23514','40001','40P01'].includes(error.code))throw failure(409);
      if(['22023','22001'].includes(error.code))throw failure(400);
      throw error;
    }
  }
  async history(hubId) {
    return this.#run(hubId,async tx=>(await tx.query(`SELECT purpose,notice_version,notice_text,published_by,published_at
      FROM compliance.notice_publications ORDER BY published_at DESC NULLS LAST,purpose,notice_version LIMIT 100`)).rows);
  }
  async publish(hubId,{purpose,noticeVersion,noticeText,expectedVersion}) {
    if(typeof purpose!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(purpose)||
      typeof noticeVersion!=='string'||!noticeVersion.trim()||noticeVersion.length>100||
      typeof noticeText!=='string'||!noticeText.trim()||noticeText.length>10000||
      !(expectedVersion===null||typeof expectedVersion==='string'&&expectedVersion.length>0&&expectedVersion.length<=100)||
      noticeVersion===expectedVersion)throw failure(400);
    return this.#run(hubId,async tx=>{
      const result=expectedVersion===null?
        await tx.query(`INSERT INTO compliance.consent_purposes(hub_id,purpose,notice_version,notice_text)
          VALUES($1,$2,$3,$4) ON CONFLICT(hub_id,purpose) DO NOTHING RETURNING purpose,notice_version,notice_text`,[hubId,purpose,noticeVersion,noticeText]):
        await tx.query(`UPDATE compliance.consent_purposes SET notice_version=$3,notice_text=$4
          WHERE hub_id=$1 AND purpose=$2 AND notice_version=$5 RETURNING purpose,notice_version,notice_text`,[hubId,purpose,noticeVersion,noticeText,expectedVersion]);
      if(!result.rows.length)throw failure(409);return result.rows[0];
    });
  }
}
