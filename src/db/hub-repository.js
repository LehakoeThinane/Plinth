import { randomUUID } from 'node:crypto';
import { TenantDatabase } from './tenant.js';
import { validateBranding } from '../modules/tenancy/branding.js';
const publicContext='00000000-0000-0000-0000-000000000000';
const notFound=()=>Object.assign(new Error('Not found'),{status:404});

export class HubRepository {
  #db;
  #userId;
  constructor(db,verifiedUserId=null) {
    if(!(db instanceof TenantDatabase))throw new Error('Tenant database required');
    this.#db=db;this.#userId=verifiedUserId;
  }
  #context(hubId) {return {hubId,userId:this.#userId,orgIds:[],isStaff:false};}
  async resolve({slug=null,hostname=null}) {
    if((slug===null)===(hostname===null) ||
      (slug!==null && (typeof slug!=='string'||! /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(slug))) ||
      (hostname!==null && (typeof hostname!=='string'||hostname.length>253||
        !/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(hostname))))
      throw Object.assign(new Error('Invalid hub locator'),{status:400});
    return this.#db.withSnapshot(this.#context(publicContext),async tx=>{
      const hub=(await tx.query('SELECT * FROM app.resolve_hub($1,$2)',[slug,hostname])).rows[0];
      if(!hub)throw notFound();
      return hub;
    });
  }
  async create({slug,displayName}) {
    if(!this.#userId)throw notFound();
    if(typeof slug!=='string'||! /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(slug))
      throw Object.assign(new Error('Invalid slug'),{status:400});
    validateBranding({displayName},publicContext);
    const hubId=randomUUID();
    try {
      return await this.#db.withSnapshot(this.#context(hubId),async tx=>{
        await tx.query('SELECT app.create_hub($1,$2)',[slug,displayName]);
        return {id:hubId,slug,displayName};
      });
    }catch(error) {
      if(error.code==='23505')throw Object.assign(new Error('Slug unavailable'),{status:409});
      if(error.code==='42501')throw notFound();
      throw error;
    }
  }
  async join(hubId) {
    if(!this.#userId)throw notFound();
    try {
      return await this.#db.withSnapshot(this.#context(hubId),async tx=>{
        const membership=(await tx.query('SELECT * FROM app.join_hub()')).rows[0];
        if(!membership)throw notFound();
        return membership;
      });
    }catch(error) {if(error.code==='42501')throw notFound();throw error;}
  }
  async membership(hubId) {
    return this.#db.withSnapshot(this.#context(hubId),async tx=>{
      const membership=(await tx.query("SELECT role,status FROM tenancy.memberships WHERE status='active'")).rows[0];
      if(!membership)throw notFound();return membership;
    });
  }
  async brand(hubId,input) {
    const fields=validateBranding(input,hubId);
    return this.#db.withSnapshot(this.#context(hubId),async tx=>{
      const result=await tx.query('UPDATE tenancy.hub_profiles SET '+fields.map(([key],i)=>key+'=$'+(i+1)).join(',')+
        ' RETURNING display_name,description,primary_color,font,logo_path',fields.map(([,value])=>value));
      if(!result.rows.length)throw notFound();return result.rows[0];
    });
  }
}
