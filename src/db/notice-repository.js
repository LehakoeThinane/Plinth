import { TenantDatabase } from './tenant.js';
const failure=status=>Object.assign(new Error('Notice publication rejected'),{status});
const kinds=['published','retired'];
const encodeCursor=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
function decodeCursor(value) {
  let cursor;
  try{cursor=typeof value==='string'&&value.length<=1024?JSON.parse(Buffer.from(value,'base64url').toString('utf8')):null;}catch{cursor=null;}
  if(!cursor||typeof cursor.at!=='string'||cursor.at.length>64||!/^[a-z][a-z0-9_]{0,63}$/.test(cursor.purpose??'')||
    typeof cursor.version!=='string'||!cursor.version||cursor.version.length>100||!kinds.includes(cursor.kind))throw failure(400);
  return cursor;
}
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
  /** Publications and retirements, newest first, in keyset-paged order.
   * Imported publications with an unknown date sort last.
   */
  async history(hubId,{before=null,limit=50}={}) {
    const size=Number(limit);
    if(!Number.isInteger(size)||size<1||size>100)throw failure(400);
    const cursor=before===null?null:decodeCursor(before);
    return this.#run(hubId,async tx=>{
      const rows=(await tx.query(`SELECT kind,purpose,notice_version,notice_text,actor,at,sort_at::text AS sort_key FROM (
          SELECT 'published' AS kind,purpose,notice_version,notice_text,published_by AS actor,published_at AS at,
            coalesce(published_at,'-infinity'::timestamptz) AS sort_at FROM compliance.notice_publications
          UNION ALL
          SELECT 'retired',purpose,notice_version,NULL,retired_by,retired_at,retired_at FROM compliance.notice_retirements) h
        WHERE $1::timestamptz IS NULL OR (sort_at,purpose,notice_version,kind)<($1::timestamptz,$2,$3,$4)
        ORDER BY sort_at DESC,purpose DESC,notice_version DESC,kind DESC LIMIT $5`,
        [cursor?.at??null,cursor?.purpose??null,cursor?.version??null,cursor?.kind??null,size+1])).rows;
      const page=rows.slice(0,size),last=page.at(-1);
      return {publications:page.map(({sort_key,...row})=>row),
        next:rows.length>size?encodeCursor({at:last.sort_key,purpose:last.purpose,version:last.notice_version,kind:last.kind}):null};
    });
  }
  async retire(hubId,{purpose,expectedVersion}={}) {
    if(typeof purpose!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(purpose)||
      typeof expectedVersion!=='string'||!expectedVersion||expectedVersion.length>100)throw failure(400);
    return this.#run(hubId,async tx=>{
      const result=await tx.query(`UPDATE compliance.consent_purposes SET retired_at=now()
        WHERE hub_id=$1 AND purpose=$2 AND notice_version=$3 AND retired_at IS NULL
        RETURNING purpose,notice_version,retired_at`,[hubId,purpose,expectedVersion]);
      if(!result.rows.length)throw failure(409);return result.rows[0];
    });
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
