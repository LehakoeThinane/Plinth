import { randomBytes,randomUUID } from 'node:crypto';
import { TenantDatabase } from './tenant.js';
import { domainDigest,proofRecordPrefix } from '../dns/txt-proof.js';
const fail=status=>Object.assign(new Error('Organisation domain change rejected'),{status});
/** Organisation admins manage claims through identity-executor functions. Only
 * the separate verifier database login can confirm a claim after DNS proof.
 */
export class OrganisationDomainRepository {
  #db;#verifier;#user;
  constructor(db,verifier,userId) {
    if(!(db instanceof TenantDatabase)||!(verifier instanceof TenantDatabase))throw Error('Tenant databases required');
    this.#db=db;this.#verifier=verifier;this.#user=userId;
  }
  async #run(db,hubId,operation) {
    for(let attempt=0;attempt<3;attempt++)try {
      return await db.withSnapshot({hubId,userId:this.#user,orgIds:[],isStaff:false},operation);
    }catch(error) {
      if(['40001','40P01'].includes(error.code) && attempt<2)continue;
      if(['42501','23503'].includes(error.code))throw fail(404);
      if(['23505','23514','40001','40P01'].includes(error.code))throw fail(409);
      if(['22023','22P02'].includes(error.code))throw fail(400);
      throw error;
    }
  }
  list(hubId,orgId) {
    return this.#run(this.#db,hubId,async tx=>(await tx.query('SELECT app.organisation_domains($1) AS result',[orgId])).rows[0].result);
  }
  request(hubId,orgId,domain) {
    const value='plinth-organisation='+randomBytes(32).toString('hex');
    return this.#run(this.#db,hubId,async tx=>{
      const expiresAt=(await tx.query('SELECT app.request_org_domain($1,$2,$3,$4) AS expires_at',[orgId,domain,domainDigest(value),randomUUID()])).rows[0].expires_at;
      // Returned once to the authorised administrator; only its hash is stored.
      return {domain,recordName:proofRecordPrefix+domain,recordValue:value,expiresAt};
    });
  }
  challenge(hubId,orgId,domain) {
    return this.#run(this.#db,hubId,async tx=>(await tx.query('SELECT app.org_domain_challenge($1,$2) AS hash',[orgId,domain])).rows[0].hash);
  }
  confirm(hubId,orgId,domain,hash) {
    return this.#run(this.#verifier,hubId,async tx=>({domain,
      verifiedAt:(await tx.query('SELECT app.confirm_org_domain($1,$2,$3,$4) AS verified_at',[orgId,domain,hash,randomUUID()])).rows[0].verified_at}));
  }
  remove(hubId,orgId,domain) {
    return this.#run(this.#db,hubId,async tx=>{await tx.query('SELECT app.remove_org_domain($1,$2,$3)',[orgId,domain,randomUUID()]);return {removed:true};});
  }
}
