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
        // Read under the same RLS context (organisations, staff) as the decision.
        getLessonContent:async id=>{
          const row=(await tx.query(`SELECT l.id,l.title,l.summary,l.product_id,p.title AS product_title,c.body
            FROM catalogue.lessons l JOIN catalogue.products p ON p.hub_id=l.hub_id AND p.id=l.product_id
            LEFT JOIN content.lesson_bodies c ON c.hub_id=l.hub_id AND c.lesson_id=l.id
            WHERE l.hub_id=$1 AND l.id=$2`,[hubId,id])).rows[0];
          return row?{id:row.id,title:row.title,summary:row.summary,productId:row.product_id,productTitle:row.product_title,body:row.body??''}:null;
        },
        getProgress:async lessonId=>{
          const row=(await tx.query(`SELECT revision,furthest_position,resume_position,completed,completed_at FROM content.lesson_progress
            WHERE hub_id=$1 AND user_id=$2 AND lesson_id=$3`,[hubId,this.userId,lessonId])).rows[0];
          return row?{revision:Number(row.revision),furthestPosition:row.furthest_position,resumePosition:row.resume_position,completed:row.completed,completedAt:row.completed_at}:null;
        },
        lockProgress:async lessonId=>{
          const row=(await tx.query(`SELECT revision,furthest_position,resume_position,completed FROM content.lesson_progress
            WHERE hub_id=$1 AND user_id=$2 AND lesson_id=$3 FOR UPDATE`,[hubId,this.userId,lessonId])).rows[0];
          return row?{revision:Number(row.revision),furthestPosition:row.furthest_position,resumePosition:row.resume_position,completed:row.completed}:null;
        },
        writeProgress:async(lessonId,state,isNew)=>{
          if(isNew)await tx.query(`INSERT INTO content.lesson_progress(hub_id,user_id,lesson_id,boundary_id,revision,furthest_position,resume_position,completed)
            SELECT hub_id,$2,id,boundary_id,$4,$5,$6,$7 FROM catalogue.lessons WHERE hub_id=$1 AND id=$3`,
            [hubId,this.userId,lessonId,state.revision,state.furthestPosition,state.resumePosition,state.completed]);
          else await tx.query(`UPDATE content.lesson_progress SET revision=$4,furthest_position=$5,resume_position=$6,completed=$7
            WHERE hub_id=$1 AND user_id=$2 AND lesson_id=$3`,[hubId,this.userId,lessonId,state.revision,state.furthestPosition,state.resumePosition,state.completed]);
        },
        findProgressRequest:async key=>{
          const row=(await tx.query('SELECT request_hash,response FROM content.progress_requests WHERE hub_id=$1 AND user_id=$2 AND idempotency_key=$3',[hubId,this.userId,key])).rows[0];
          return row?{requestHash:row.request_hash,response:row.response}:null;
        },
        storeProgressRequest:async(key,hash,response)=>{
          await tx.query('INSERT INTO content.progress_requests(hub_id,user_id,idempotency_key,request_hash,response) VALUES($1,$2,$3,$4,$5::jsonb)',[hubId,this.userId,key,hash,JSON.stringify(response)]);
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
