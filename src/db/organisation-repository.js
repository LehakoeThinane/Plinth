import { randomUUID,randomBytes,createHash } from 'node:crypto';
import { TenantDatabase } from './tenant.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid=()=>Object.assign(new Error('Invalid organisation request'),{status:400});
const hash=token=>createHash('sha256').update(token).digest('hex');
function names(input) {
  for(const key of ['displayName','legalName'])if(typeof input[key]!=='string'||!input[key].trim()||input[key].trim().length>200)throw invalid();
  return {displayName:input.displayName.trim(),legalName:input.legalName.trim()};
}
export class OrganisationRepository {
  #db;#userId;
  constructor(database,userId) {if(!(database instanceof TenantDatabase))throw Error('Tenant database required');this.#db=database;this.#userId=userId;}
  async #run(hubId,operation) {
    for(let attempt=0;attempt<3;attempt++)try {
      return await this.#db.withSnapshot({hubId,userId:this.#userId,orgIds:[],isStaff:false},operation);
    }catch(error) {
      if(['40001','40P01'].includes(error.code) && attempt<2)continue;
      if(['42501','23503'].includes(error.code))throw Object.assign(new Error('Not found'),{status:404});
      if(['23505','23514','40001','40P01'].includes(error.code))throw Object.assign(new Error('Organisation conflict'),{status:409});
      if(['22023','22P02'].includes(error.code))throw invalid();
      throw error;
    }
  }
  async create(hubId,input) {
    const fields=names(input);if(!['company','provider'].includes(input.type))throw invalid();
    const id=randomUUID(),event=randomUUID();
    await this.#run(hubId,tx=>tx.query('SELECT app.create_organisation($1,$2,$3,$4,$5)',[id,fields.displayName,input.type,fields.legalName,event]));
    return {id,...fields,type:input.type,role:'admin'};
  }
  async admin(hubId,orgId) {
    if(!uuid.test(orgId))throw invalid();
    return this.#run(hubId,async tx=>(await tx.query('SELECT app.organisation_admin_view($1) AS result',[orgId])).rows[0].result);
  }
  async #mutate(hubId,orgId,action,input) {
    if(!uuid.test(orgId))throw invalid();
    const event=randomUUID();
    await this.#run(hubId,tx=>tx.query('SELECT app.manage_organisation($1,$2,$3,$4)',[orgId,action,input,event]));
  }
  async rename(hubId,orgId,input) {await this.#mutate(hubId,orgId,'renamed',names(input));return {saved:true};}
  async invite(hubId,orgId,{userId}) {
    if(!uuid.test(userId??''))throw invalid();
    const token=randomBytes(32).toString('hex'),id=randomUUID();
    await this.#mutate(hubId,orgId,'invited',{id,userId,tokenHash:hash(token)});
    return {id,token}; // Returned once to the authorised administrator, never logged/stored raw.
  }
  async revoke(hubId,orgId,id) {
    if(!uuid.test(id))throw invalid();await this.#mutate(hubId,orgId,'invite_revoked',{id});return {revoked:true};
  }
  async accept(hubId,orgId,{token}) {
    if(typeof token!=='string'||!/^[0-9a-f]{64}$/.test(token))throw invalid();
    await this.#mutate(hubId,orgId,'accepted',{tokenHash:hash(token)});return {joined:true};
  }
  async member(hubId,orgId,userId,role=null) {
    if(!uuid.test(userId)||role!==null&&!['admin','member'].includes(role))throw invalid();
    await this.#mutate(hubId,orgId,role===null?'removed':'role_changed',{userId,role});return {saved:true};
  }
}
