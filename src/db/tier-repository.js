import { randomUUID } from 'node:crypto';
import { TenantDatabase } from './tenant.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=status=>Object.assign(new Error('Tier request rejected'),{status});
const id=value=>{if(typeof value!=='string'||!uuid.test(value))throw fail(400);return value;};
const benefitTypes=['product','space','library'];
// Benefit titles for one hub; the public view shows only live items.
const benefitsSql=live=>`SELECT b.tier_id,b.target_type,b.target_id,coalesce(p.title,s.title,l.title) AS title
  FROM access.tier_benefits b
  LEFT JOIN catalogue.products p ON b.target_type='product' AND p.hub_id=b.hub_id AND p.id=b.target_id ${live?"AND p.status='published'":''}
  LEFT JOIN community.spaces s ON b.target_type='space' AND s.hub_id=b.hub_id AND s.id=b.target_id ${live?"AND s.status='active'":''}
  LEFT JOIN library.items l ON b.target_type='library' AND l.hub_id=b.hub_id AND l.id=b.target_id ${live?"AND l.status='published'":''}
  WHERE b.tier_id=ANY($1::uuid[]) ORDER BY b.target_type,title`;
function fields(input,{partial=false}={}) {
  const out={};
  if(!partial||input.name!==undefined){if(typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>80)throw fail(400);out.name=input.name.trim();}
  if(input.description!==undefined){if(typeof input.description!=='string'||input.description.length>2000)throw fail(400);out.description=input.description;}
  if(!partial||input.rank!==undefined){if(!Number.isInteger(input.rank)||input.rank<1||input.rank>100)throw fail(400);out.rank=input.rank;}
  if(!partial||input.amountCents!==undefined){if(!Number.isInteger(input.amountCents)||input.amountCents<100||input.amountCents>100000000)throw fail(400);out.amountCents=input.amountCents;}
  if(!partial||input.interval!==undefined){if(!['month','year'].includes(input.interval))throw fail(400);out.interval=input.interval;}
  return out;
}
/** Membership tiers for hub owners/admins, and the public comparison. Tier
 * benefits feed the existing access decisions for products, spaces and library.
 */
export class TierRepository {
  #db;#userId;
  constructor(db,userId=null) {if(!(db instanceof TenantDatabase))throw Error('Tenant database required');this.#db=db;this.#userId=userId;}
  async #run(hubId,admin,operation) {
    try {
      return await this.#db.withSnapshot({hubId,userId:admin?this.#userId:null,orgIds:[],isStaff:false},async tx=>{
        if(admin&&(!this.#userId||!(await tx.query('SELECT app.is_hub_admin() AS allowed')).rows[0].allowed))throw fail(404);
        return operation(tx);
      });
    }catch(error) {
      if(error.status)throw error;
      if(error.code==='42501')throw fail(404);
      if(['23503','22023','22P02'].includes(error.code))throw fail(400);
      if(['23505','23514','40001','40P01'].includes(error.code))throw fail(409);
      throw error;
    }
  }
  async #withBenefits(tx,tiers,live) {
    if(!tiers.length)return tiers;
    const rows=(await tx.query(benefitsSql(live),[tiers.map(t=>t.id)])).rows;
    return tiers.map(t=>({...t,benefits:rows.filter(b=>b.tier_id===t.id&&b.title!==null).map(({tier_id,...b})=>b)}));
  }
  async list(hubId) {
    return this.#run(hubId,true,async tx=>this.#withBenefits(tx,(await tx.query(`SELECT id,name,description,rank,amount_cents,billing_interval,status,published_at
      FROM commerce.tiers ORDER BY status='archived',rank,created_at`)).rows,false));
  }
  async create(hubId,input) {
    const f=fields(input);
    return this.#run(hubId,true,async tx=>{
      const tierId=randomUUID();
      await tx.query('INSERT INTO commerce.tiers(hub_id,id,name,description,rank,amount_cents,billing_interval) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [hubId,tierId,f.name,f.description??'',f.rank,f.amountCents,f.interval]);
      return {id:tierId,...f,status:'draft'};
    });
  }
  async get(hubId,tierId) {
    id(tierId);
    return this.#run(hubId,true,async tx=>{
      const tier=(await tx.query('SELECT id,name,description,rank,amount_cents,billing_interval,status,published_at FROM commerce.tiers WHERE id=$1',[tierId])).rows[0];
      if(!tier)throw fail(404);
      // Candidates a provider may add: paid shelf products, tier spaces, tier or buyer library items.
      const candidates=(await tx.query(`SELECT 'product' AS target_type,id AS target_id,title FROM catalogue.products WHERE access_mode='entitled' AND visibility<>'company'
        UNION ALL SELECT 'space',id,title FROM community.spaces WHERE visibility='tier'
        UNION ALL SELECT 'library',id,title FROM library.items WHERE visibility IN ('tier','entitled') ORDER BY 1,3`)).rows;
      return {tier:(await this.#withBenefits(tx,[tier],false))[0],candidates};
    });
  }
  async update(hubId,tierId,input) {
    id(tierId);const f=fields(input,{partial:true});
    if(!Object.keys(f).length)throw fail(400);
    return this.#run(hubId,true,async tx=>{
      const row=(await tx.query(`UPDATE commerce.tiers SET name=coalesce($2,name),description=coalesce($3,description),rank=coalesce($4,rank),
        amount_cents=coalesce($5,amount_cents),billing_interval=coalesce($6,billing_interval) WHERE id=$1
        RETURNING id,name,description,rank,amount_cents,billing_interval,status`,[tierId,f.name??null,f.description??null,f.rank??null,f.amountCents??null,f.interval??null])).rows[0];
      if(!row)throw fail(404);return row;
    });
  }
  async setStatus(hubId,tierId,status) {
    id(tierId);
    if(!['published','archived'].includes(status))throw fail(400);
    return this.#run(hubId,true,async tx=>{
      const row=(await tx.query('UPDATE commerce.tiers SET status=$2 WHERE id=$1 AND status<>$2 RETURNING id,status,published_at',[tierId,status])).rows[0];
      if(!row)throw fail(409);return row;
    });
  }
  async addBenefit(hubId,tierId,input) {
    id(tierId);id(input?.targetId);
    if(!benefitTypes.includes(input.targetType))throw fail(400);
    return this.#run(hubId,true,async tx=>{
      if(!(await tx.query("SELECT 1 FROM commerce.tiers WHERE id=$1 AND status<>'archived'",[tierId])).rows.length)throw fail(404);
      await tx.query(`INSERT INTO access.tier_benefits(hub_id,tier_id,target_id,target_type) VALUES($1,$2,$3,$4)
        ON CONFLICT DO NOTHING`,[hubId,tierId,input.targetId,input.targetType]);
      return {tierId,targetType:input.targetType,targetId:input.targetId};
    });
  }
  async removeBenefit(hubId,tierId,targetId) {
    id(tierId);id(targetId);
    return this.#run(hubId,true,async tx=>{
      const removed=await tx.query('DELETE FROM access.tier_benefits WHERE tier_id=$1 AND target_id=$2',[tierId,targetId]);
      if(!removed.rowCount)throw fail(404);return {removed:true};
    });
  }
  /** Published tiers by rank with their live benefits: the public comparison. */
  async compare(hubId) {
    return this.#run(hubId,false,async tx=>({tiers:await this.#withBenefits(tx,(await tx.query(`SELECT id,name,description,rank,amount_cents,billing_interval
      FROM commerce.tiers WHERE status='published' ORDER BY rank`)).rows,true)}));
  }
}
