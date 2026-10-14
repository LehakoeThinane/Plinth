import { TenantDatabase } from './tenant.js';
/** A learner's own view of what they can study in one hub, with progress.
 * It is a navigation aid: every lesson is still access-checked when opened.
 * Company boundaries use organisation memberships read in the same transaction.
 */
export class LearningRepository {
  #db;#userId;
  constructor(db,userId) {if(!(db instanceof TenantDatabase))throw Error('Tenant database required');this.#db=db;this.#userId=userId;}
  async learning(hubId) {
    return this.#db.withSnapshot({hubId,userId:this.#userId,orgIds:[],isStaff:false},async tx=>{
      const member=(await tx.query("SELECT 1 FROM tenancy.memberships WHERE hub_id=$1 AND user_id=$2 AND status='active'",[hubId,this.#userId])).rows.length>0;
      if(!member)return {products:[]};
      const orgIds=(await tx.query("SELECT org_id FROM identity.org_members WHERE user_id=$1 AND status='active'",[this.#userId])).rows.map(r=>r.org_id);
      await tx.query("SELECT set_config('app.org_ids',$1,true)",[JSON.stringify(orgIds)]);
      // Products held directly or through a tier, plus free products already started.
      // Paid products appear only while an entitlement is active.
      const products=(await tx.query(`WITH active AS (
          SELECT target_id,kind FROM access.entitlements WHERE hub_id=$1 AND user_id=$2 AND NOT revoked AND (expires_at IS NULL OR expires_at>now())),
        mine AS (
          SELECT target_id AS product_id FROM active WHERE kind='product'
          UNION SELECT b.target_id FROM active a JOIN access.tier_benefits b ON b.hub_id=$1 AND b.tier_id=a.target_id WHERE a.kind='tier'
          UNION SELECT l.product_id FROM content.lesson_progress p JOIN catalogue.lessons l ON l.hub_id=p.hub_id AND l.id=p.lesson_id
            JOIN catalogue.products f ON f.hub_id=l.hub_id AND f.id=l.product_id WHERE p.hub_id=$1 AND f.access_mode IN ('open','members'))
        SELECT p.id,p.type,p.title FROM catalogue.products p WHERE p.status='published' AND p.id IN (SELECT product_id FROM mine)
        ORDER BY p.title,p.id`,[hubId,this.#userId])).rows;
      if(!products.length)return {products:[]};
      const lessons=(await tx.query(`SELECT l.id,l.product_id,l.title,m.title AS module_title,coalesce(pr.completed,false) AS completed
        FROM catalogue.lessons l JOIN catalogue.modules m ON m.hub_id=l.hub_id AND m.id=l.module_id
        LEFT JOIN content.lesson_progress pr ON pr.hub_id=l.hub_id AND pr.lesson_id=l.id AND pr.user_id=$2
        WHERE l.hub_id=$1 AND l.status='published' AND l.product_id=ANY($3::uuid[]) ORDER BY m.position,l.position`,
        [hubId,this.#userId,products.map(p=>p.id)])).rows;
      return {products:products.map(p=>{
        const own=lessons.filter(l=>l.product_id===p.id).map(({product_id,...l})=>l);
        return {...p,total:own.length,completed:own.filter(l=>l.completed).length,next:own.find(l=>!l.completed)?.id??null,lessons:own};
      })};
    });
  }
}
