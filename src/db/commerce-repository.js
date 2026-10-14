import { randomUUID,createHash } from 'node:crypto';
import { TenantDatabase } from './tenant.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=(status,code)=>Object.assign(new Error(code??'Commerce request rejected'),{status,code});
function mapError(error) {
  if(error.status)return error;
  if(error.code==='42501')return fail(404);
  if(['23503','22023','22P02'].includes(error.code))return fail(400);
  if(['23505','23514','40001','40P01'].includes(error.code))return fail(409);
  return error;
}
/** Buyer and provider views of orders, as the verified person (plinth_app).
 * Orders start pending; nothing here can mark one paid.
 */
export class CommerceRepository {
  #db;#userId;
  constructor(db,userId) {if(!(db instanceof TenantDatabase))throw Error('Tenant database required');this.#db=db;this.#userId=userId;}
  async #run(hubId,operation) {
    if(!this.#userId)throw fail(401);
    try{return await this.#db.withSnapshot({hubId,userId:this.#userId,orgIds:[],isStaff:false},operation);}
    catch(error){throw mapError(error);}
  }
  /** Creates a pending order for one once-off plan. The same idempotency key with
   * the same plan returns the same order; with a different plan it is a conflict.
   */
  async createOrder(hubId,{planId,idempotencyKey}) {
    if(!uuid.test(planId??''))throw fail(400);
    if(typeof idempotencyKey!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey))throw fail(400,'idempotency_key_required');
    const requestHash=createHash('sha256').update(JSON.stringify({planId})).digest('hex');
    return this.#run(hubId,async tx=>{
      const replay=(await tx.query('SELECT id,request_hash,status,total_cents,psp_reference FROM commerce.orders WHERE buyer_id=$1 AND idempotency_key=$2',[this.#userId,idempotencyKey])).rows[0];
      if(replay){if(replay.request_hash!==requestHash)throw fail(409,'idempotency_key_reused');return {...replay,replayed:true};}
      if(!(await tx.query('SELECT app.is_active_member() AS ok')).rows[0].ok)throw fail(409,'join_first');
      const plan=(await tx.query(`SELECT s.id,s.amount_cents,s.model,p.id AS product_id,p.title FROM catalogue.plans s JOIN catalogue.products p ON p.hub_id=s.hub_id AND p.id=s.product_id
        WHERE s.id=$1 AND s.status='active' AND p.status='published' AND p.visibility<>'company' AND p.access_mode='entitled'`,[planId])).rows[0];
      if(!plan)throw fail(404);
      // Subscriptions and seats are separate slices.
      if(plan.model!=='once_off')throw fail(409,'not_yet_supported');
      const owned=await tx.query(`SELECT 1 FROM access.entitlements WHERE user_id=$1 AND target_id=$2 AND NOT revoked
        AND (expires_at IS NULL OR expires_at>now())`,[this.#userId,plan.product_id]);
      if(owned.rows.length)throw fail(409,'already_owned');
      const orderId=randomUUID();
      await tx.query(`INSERT INTO commerce.orders(hub_id,id,buyer_id,subtotal_cents,total_cents,idempotency_key,request_hash)
        VALUES($1,$2,$3,$4,$4,$5,$6)`,[hubId,orderId,this.#userId,plan.amount_cents,idempotencyKey,requestHash]);
      await tx.query(`INSERT INTO commerce.order_lines(hub_id,order_id,line,plan_id,product_id,quantity,unit_amount_cents,amount_cents)
        VALUES($1,$2,1,$3,$4,1,$5,$5)`,[hubId,orderId,plan.id,plan.product_id,plan.amount_cents]);
      return {id:orderId,status:'pending',total_cents:plan.amount_cents,psp_reference:null,description:plan.title,replayed:false};
    });
  }
  /** Starts a subscription to a published tier or a subscription-priced product:
   * a pending subscription and its first order. Payment activates both.
   */
  async createSubscription(hubId,{tierId=null,planId=null,idempotencyKey}) {
    if((tierId===null)===(planId===null)||![tierId,planId].filter(Boolean).every(v=>uuid.test(v)))throw fail(400);
    if(typeof idempotencyKey!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey))throw fail(400,'idempotency_key_required');
    const requestHash=createHash('sha256').update(JSON.stringify({tierId,planId})).digest('hex');
    return this.#run(hubId,async tx=>{
      const replay=(await tx.query('SELECT id,request_hash,status,total_cents,psp_reference,subscription_id FROM commerce.orders WHERE buyer_id=$1 AND idempotency_key=$2',[this.#userId,idempotencyKey])).rows[0];
      if(replay){if(replay.request_hash!==requestHash)throw fail(409,'idempotency_key_reused');return {...replay,replayed:true};}
      if(!(await tx.query('SELECT app.is_active_member() AS ok')).rows[0].ok)throw fail(409,'join_first');
      let target;
      if(tierId) {
        target=(await tx.query("SELECT id AS tier_id,NULL::uuid AS plan_id,NULL::uuid AS product_id,name AS title,amount_cents,billing_interval FROM commerce.tiers WHERE id=$1 AND status='published'",[tierId])).rows[0];
      } else {
        target=(await tx.query(`SELECT NULL::uuid AS tier_id,s.id AS plan_id,p.id AS product_id,p.title,s.amount_cents,s.billing_interval,s.model
          FROM catalogue.plans s JOIN catalogue.products p ON p.hub_id=s.hub_id AND p.id=s.product_id
          WHERE s.id=$1 AND s.status='active' AND p.status='published' AND p.visibility<>'company' AND p.access_mode='entitled'`,[planId])).rows[0];
        if(target&&target.model!=='subscription')throw fail(409,'not_a_subscription');
      }
      if(!target)throw fail(404);
      const live=await tx.query(`SELECT 1 FROM commerce.subscriptions WHERE subscriber_id=$1 AND coalesce(tier_id,product_id)=$2 AND status IN ('active','past_due')`,
        [this.#userId,target.tier_id??target.product_id]);
      if(live.rows.length)throw fail(409,'already_subscribed');
      const subscriptionId=randomUUID(),orderId=randomUUID();
      await tx.query(`INSERT INTO commerce.subscriptions(hub_id,id,subscriber_id,tier_id,plan_id,product_id,amount_cents,billing_interval)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[hubId,subscriptionId,this.#userId,target.tier_id,target.plan_id,target.product_id,target.amount_cents,target.billing_interval]);
      await tx.query(`INSERT INTO commerce.orders(hub_id,id,buyer_id,subtotal_cents,total_cents,idempotency_key,request_hash,kind,subscription_id)
        VALUES($1,$2,$3,$4,$4,$5,$6,'subscription_start',$7)`,[hubId,orderId,this.#userId,target.amount_cents,idempotencyKey,requestHash,subscriptionId]);
      await tx.query(`INSERT INTO commerce.order_lines(hub_id,order_id,line,plan_id,product_id,tier_id,quantity,unit_amount_cents,amount_cents)
        VALUES($1,$2,1,$3,$4,$5,1,$6,$6)`,[hubId,orderId,target.plan_id,target.product_id,target.tier_id,target.amount_cents]);
      return {id:orderId,subscription_id:subscriptionId,status:'pending',total_cents:target.amount_cents,psp_reference:null,
        description:target.title+' ('+(target.billing_interval==='year'?'yearly':'monthly')+')',replayed:false};
    });
  }
  async subscriptions(hubId) {
    return this.#run(hubId,async tx=>(await tx.query(`SELECT s.id,s.status,s.amount_cents,s.billing_interval,s.cancel_at_period_end,s.current_period_end,
      s.psp_reference,coalesce(t.name,p.title) AS title,s.tier_id,s.product_id
      FROM commerce.subscriptions s LEFT JOIN commerce.tiers t ON t.hub_id=s.hub_id AND t.id=s.tier_id
      LEFT JOIN catalogue.products p ON p.hub_id=s.hub_id AND p.id=s.product_id
      WHERE s.subscriber_id=$1 AND s.status<>'pending' ORDER BY s.created_at DESC LIMIT 100`,[this.#userId])).rows);
  }
  /** Stops renewal at the end of the paid period; access runs until then. */
  async cancelSubscription(hubId,subscriptionId) {
    if(!uuid.test(subscriptionId??''))throw fail(400);
    return this.#run(hubId,async tx=>{
      const row=(await tx.query(`UPDATE commerce.subscriptions SET cancel_at_period_end=true WHERE id=$1 AND subscriber_id=$2
        AND status IN ('active','past_due') AND NOT cancel_at_period_end RETURNING id,psp_provider,psp_reference,current_period_end`,[subscriptionId,this.#userId])).rows[0];
      if(!row)throw fail(409,'not_cancellable');return row;
    });
  }
  /** Records the provider's session reference once, on the buyer's own pending order. */
  async attachReference(hubId,orderId,provider,reference) {
    return this.#run(hubId,async tx=>{
      const updated=await tx.query('UPDATE commerce.orders SET psp_provider=$3,psp_reference=$4 WHERE id=$1 AND buyer_id=$2 AND psp_reference IS NULL',
        [orderId,this.#userId,provider,reference]);
      if(!updated.rowCount)throw fail(409);
    });
  }
  async orders(hubId) {
    return this.#run(hubId,async tx=>(await tx.query(`SELECT o.id,o.status,o.total_cents,o.created_at,o.paid_at,l.product_id,p.title
      FROM commerce.orders o JOIN commerce.order_lines l ON l.hub_id=o.hub_id AND l.order_id=o.id AND l.line=1
      JOIN catalogue.products p ON p.hub_id=o.hub_id AND p.id=l.product_id WHERE o.buyer_id=$1 ORDER BY o.created_at DESC LIMIT 100`,[this.#userId])).rows);
  }
  async order(hubId,orderId) {
    if(!uuid.test(orderId??''))throw fail(400);
    return this.#run(hubId,async tx=>{
      const row=(await tx.query(`SELECT o.id,o.status,o.subtotal_cents,o.vat_cents,o.total_cents,o.created_at,o.paid_at,o.psp_reference,l.product_id,p.title
        FROM commerce.orders o JOIN commerce.order_lines l ON l.hub_id=o.hub_id AND l.order_id=o.id AND l.line=1
        JOIN catalogue.products p ON p.hub_id=o.hub_id AND p.id=l.product_id WHERE o.id=$1 AND o.buyer_id=$2`,[orderId,this.#userId])).rows[0];
      if(!row)throw fail(404);return row;
    });
  }
  /** Owners/admins: what a refund needs. The refund itself is applied only from
   * the provider's signed confirmation.
   */
  async refundable(hubId,orderId) {
    if(!uuid.test(orderId??''))throw fail(400);
    return this.#run(hubId,async tx=>{
      if(!(await tx.query('SELECT app.is_hub_admin() AS ok')).rows[0].ok)throw fail(404);
      const row=(await tx.query('SELECT id,status,total_cents,psp_provider,psp_reference FROM commerce.orders WHERE id=$1',[orderId])).rows[0];
      if(!row)throw fail(404);
      if(row.status!=='paid')throw fail(409,'not_refundable');
      return row;
    });
  }
  /** Owners/admins: the hub's orders and ledger totals by account. */
  async sales(hubId) {
    return this.#run(hubId,async tx=>{
      if(!(await tx.query('SELECT app.is_hub_admin() AS ok')).rows[0].ok)throw fail(404);
      const orders=(await tx.query(`SELECT o.id,o.status,o.total_cents,o.buyer_id,o.created_at,o.paid_at,p.title
        FROM commerce.orders o JOIN commerce.order_lines l ON l.hub_id=o.hub_id AND l.order_id=o.id AND l.line=1
        JOIN catalogue.products p ON p.hub_id=o.hub_id AND p.id=l.product_id ORDER BY o.created_at DESC LIMIT 200`)).rows;
      // Net totals per account: refunds are reversing entries, so they net out here.
      const ledger=(await tx.query(`SELECT account,sum(debit_cents)::bigint AS debit_cents,sum(credit_cents)::bigint AS credit_cents
        FROM commerce.ledger_entries GROUP BY account ORDER BY account`)).rows;
      return {orders,ledger};
    });
  }
}
/** Applies verified provider events through the payments login, which can only
 * call app.record_payment_event. Never give this pool to request handlers.
 */
export class PaymentsRepository {
  #pool;
  constructor(pool) {if(!pool)throw Error('Payments pool required');this.#pool=pool;}
  async record(event) {
    return (await this.#pool.query('SELECT app.record_payment_event($1,$2,$3,$4,$5,$6,$7) AS outcome',
      [event.provider,event.id,event.type,event.reference,event.amountCents,event.feeCents,event.payloadHash])).rows[0].outcome;
  }
}
