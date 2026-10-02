import { randomBytes } from 'node:crypto';
import { domainDigest } from '../modules/tenancy/domain-verification.js';
const fail=status=>Object.assign(new Error('Domain change rejected'),{status});
export class DomainRepository {
  #db;#verifier;#user;
  constructor(db,verifier,userId){this.#db=db;this.#verifier=verifier;this.#user=userId;}
  #context(hubId){return {hubId,userId:this.#user,orgIds:[],isStaff:false};}
  async #run(db,hubId,operation) {
    try{return await db.withSnapshot(this.#context(hubId),async tx=>{
      if(!(await tx.query('SELECT app.is_hub_admin() AS allowed')).rows[0].allowed)throw fail(404);
      return operation(tx);
    });}catch(error){if(error.code==='42501')throw fail(404);if(['23505','23514','40001','40P01'].includes(error.code))throw fail(409);throw error;}
  }
  list(hubId){return this.#run(this.#db,hubId,async tx=>({
    claims:(await tx.query('SELECT hostname,expires_at FROM tenancy.domain_claims ORDER BY hostname LIMIT 100')).rows,
    verified:(await tx.query('SELECT hostname,verified_at FROM tenancy.hub_domains WHERE verified_at IS NOT NULL ORDER BY hostname LIMIT 100')).rows
  }));}
  request(hubId,hostname){return this.#run(this.#db,hubId,async tx=>{
    const value='plinth-domain='+randomBytes(32).toString('hex');
    const result=await tx.query("INSERT INTO tenancy.domain_claims(hub_id,hostname,challenge_hash,requested_by) VALUES($1,$2,$3,$4) ON CONFLICT(hub_id,hostname) DO UPDATE SET challenge_hash=excluded.challenge_hash,requested_by=excluded.requested_by,expires_at=now()+interval '24 hours' RETURNING expires_at",[hubId,hostname,domainDigest(value),this.#user]);
    return {hostname,recordName:'_plinth-verification.'+hostname,recordValue:value,expiresAt:result.rows[0].expires_at};
  });}
  challenge(hubId,hostname){return this.#run(this.#db,hubId,async tx=>{
    const row=(await tx.query('SELECT challenge_hash FROM tenancy.domain_claims WHERE hostname=$1 AND expires_at>clock_timestamp()',[hostname])).rows[0];
    if(!row)throw fail(409);return row;
  });}
  // The dedicated verifier has no direct table access; it can only call this function.
  async confirm(hubId,hostname,hash) {
    try{return await this.#verifier.withSnapshot(this.#context(hubId),async tx=>({hostname,
      verifiedAt:(await tx.query('SELECT app.confirm_domain($1,$2) AS verified_at',[hostname,hash])).rows[0].verified_at}));}
    catch(error){if(error.code==='42501')throw fail(404);if(['23505','23514','40001','40P01'].includes(error.code))throw fail(409);throw error;}
  }
  remove(hubId,hostname){return this.#run(this.#db,hubId,async tx=>{
    await tx.query('DELETE FROM tenancy.domain_claims WHERE hostname=$1',[hostname]);
    await tx.query('DELETE FROM tenancy.hub_domains WHERE hostname=$1',[hostname]);return {removed:true};
  });}
}
