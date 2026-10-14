import { createHash } from 'node:crypto';
import { TenantDatabase } from './tenant.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=(status,code)=>Object.assign(new Error(code??'Seat request rejected'),{status,code});
// Database refusals that name a reason the screens can explain.
const reasons=new Set(['no_seats_left','not_company_member','member_suspended','seats_ended','purchased_seats',
  'not_a_paid_product','wrong_organisation','unknown_organisation','idempotency_key_reused']);
function mapError(error) {
  if(error.status)return error;
  if(error.code==='42501')return fail(404,'not_found');
  if(['23505','23514'].includes(error.code)&&reasons.has(error.message))return fail(409,error.message);
  if(['23503','22023','22P02'].includes(error.code))return fail(400,'invalid_request');
  if(['23505','23514','40001','40P01'].includes(error.code))return fail(409,'conflict');
  return error;
}
/** Company seats (Flow B), as the verified person. Every change goes through a
 * database function that checks the caller's hub or company role itself.
 */
export class SeatRepository {
  #db;#userId;
  constructor(db,userId) {if(!(db instanceof TenantDatabase))throw Error('Tenant database required');this.#db=db;this.#userId=userId;}
  async #run(hubId,operation) {
    if(!this.#userId)throw fail(401,'unauthenticated');
    for(let attempt=0;;attempt++) {
      try{return await this.#db.withSnapshot({hubId,userId:this.#userId,orgIds:[],isStaff:false},operation);}
      catch(error) {
        // Two admins changing the same pool at once: the later one retries on fresh
        // data and then gets the true answer (for example no_seats_left).
        if(['40001','40P01'].includes(error.code)&&attempt<3)continue;
        throw mapError(error);
      }
    }
  }
  /** Organisations the caller administers, for the company seats screen. */
  async companies(hubId) {
    return this.#run(hubId,async tx=>(await tx.query(`SELECT o.id,o.display_name FROM identity.org_members m JOIN identity.organisations o ON o.id=m.org_id
      WHERE m.user_id=$1 AND m.status='active' AND m.role='admin' ORDER BY o.display_name,o.id`,[this.#userId])).rows);
  }
  /** A company admin's view of one organisation's seats, or (orgId null) the hub admins' view of all. */
  async overview(hubId,orgId=null) {
    if(orgId!==null&&!uuid.test(orgId))throw fail(400,'invalid_request');
    return this.#run(hubId,async tx=>(await tx.query('SELECT app.seat_overview($1) AS view',[orgId])).rows[0].view);
  }
  /** Hub owners/admins: seats for a deal paid off the platform. A retry with the
   * same idempotency key and details returns the same pool.
   */
  async grant(hubId,{orgId,productId,seats,reference,idempotencyKey}) {
    if(typeof idempotencyKey!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey))throw fail(400,'idempotency_key_required');
    if(![orgId,productId].every(v=>uuid.test(v??''))||!Number.isInteger(seats)||typeof reference!=='string')throw fail(400,'invalid_request');
    const poolId=keyedId(hubId,this.#userId,'seat-grant',idempotencyKey);
    return this.#run(hubId,async tx=>({poolId:(await tx.query('SELECT app.grant_seats($1,$2,$3,$4,$5) AS id',[poolId,orgId,productId,seats,reference])).rows[0].id}));
  }
  async endPool(hubId,poolId) {
    if(!uuid.test(poolId??''))throw fail(400,'invalid_request');
    return this.#run(hubId,async tx=>{await tx.query('SELECT app.end_seat_pool($1)',[poolId]);return {ended:true};});
  }
  /** Company admins: assigning the same person again returns their existing seat. */
  async assign(hubId,poolId,userId) {
    if(![poolId,userId].every(v=>uuid.test(v??'')))throw fail(400,'invalid_request');
    return this.#run(hubId,async tx=>({entitlementId:(await tx.query('SELECT app.assign_seat($1,$2) AS id',[poolId,userId])).rows[0].id}));
  }
  async revoke(hubId,poolId,userId) {
    if(![poolId,userId].every(v=>uuid.test(v??'')))throw fail(400,'invalid_request');
    return this.#run(hubId,async tx=>({revoked:(await tx.query('SELECT app.revoke_seat($1,$2) AS done',[poolId,userId])).rows[0].done}));
  }
}
/** A stable UUID for one caller's idempotency key, so a retried grant finds its pool. */
function keyedId(...parts) {
  const h=createHash('sha256').update(parts.join('\n')).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-${(8|parseInt(h[16],16)&3).toString(16)}${h.slice(17,20)}-${h.slice(20,32)}`;
}
