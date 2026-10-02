/** Bound to a verified principal. Roles/company IDs are loaded from PostgreSQL
 * in the SAME snapshot as the access decisions, never from request headers.
 */
export class PostgresAccessRepository {
  constructor(database, userId) { this.database=database; this.userId=userId; }
  async withSnapshot(hubId, operation) {
    return this.database.withSnapshot({hubId,userId:this.userId,orgIds:[],isStaff:false},async tx=>{
      const member=(await tx.query('SELECT role,status FROM tenancy.memberships WHERE hub_id=$1 AND user_id=$2',[hubId,this.userId])).rows[0] ?? null;
      const orgIds=(await tx.query("SELECT org_id FROM identity.org_members WHERE user_id=$1 AND status='active'",[this.userId])).rows.map(r=>r.org_id);
      const isStaff=member?.status==='active' && ['owner','admin','facilitator','staff'].includes(member.role);
      await tx.query("SELECT set_config('app.org_ids',$1,true),set_config('app.is_staff',$2,true)",[JSON.stringify(orgIds),String(isStaff)]);
      const assertUser=id=>{if(id!==this.userId)throw Error('Principal mismatch');};
      return operation({
        getTargetChain:async id=>{
          const lesson=(await tx.query(`SELECT l.*,b.company_org FROM catalogue.lessons l JOIN tenancy.boundaries b ON b.hub_id=l.hub_id AND b.id=l.boundary_id WHERE l.hub_id=$1 AND l.id=$2`,[hubId,id])).rows[0];
          if(!lesson)return [];
          const product=(await tx.query(`SELECT p.*,b.company_org FROM catalogue.products p JOIN tenancy.boundaries b ON b.hub_id=p.hub_id AND b.id=p.boundary_id WHERE p.hub_id=$1 AND p.id=$2`,[hubId,lesson.product_id])).rows[0];
          if(!product)return [];
          const map=r=>({id:r.id,hubId:r.hub_id,companyOrg:r.company_org,status:r.status,access:r.access_mode,visibility:r.visibility,previewAvailable:r.preview_available??false});
          return [map(lesson),map(product)];
        },
        getVersions:async id=>{assertUser(id);const r=(await tx.query('SELECT u.access_version,h.access_epoch FROM identity.users u CROSS JOIN tenancy.hubs h WHERE u.id=$1 AND h.id=$2',[id,hubId])).rows[0];return r?{userVersion:r.access_version,hubEpoch:r.access_epoch}:null;},
        getAccessSummary:async id=>{
          assertUser(id);
          const es=(await tx.query('SELECT target_id,kind,expires_at,revoked FROM access.entitlements WHERE hub_id=$1 AND user_id=$2',[hubId,id])).rows;
          const bs=(await tx.query('SELECT tier_id,target_id FROM access.tier_benefits WHERE hub_id=$1',[hubId])).rows;
          const tierBenefits=Object.create(null);for(const b of bs)(tierBenefits[b.tier_id]??=[]).push(b.target_id);
          return {membership:member,orgIds,entitlements:es.map(e=>({targetId:e.target_id,kind:e.kind,expiresAt:e.expires_at?.getTime()??null,revoked:e.revoked})),tierBenefits};
        }
      });
    });
  }
}
