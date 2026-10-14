import { randomUUID } from 'node:crypto';
import { TenantDatabase } from './tenant.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=status=>Object.assign(new Error('Community request rejected'),{status});
export const reactionKinds=['like','insightful','thanks'];
const body=(value,max)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw fail(400);return value;};
const id=value=>{if(typeof value!=='string'||!uuid.test(value))throw fail(400);return value;};
function mapError(error) {
  if(error.status)return error;
  if(error.code==='42501')return fail(404);
  if(['23503','22023','22P02'].includes(error.code))return fail(400);
  if(['23505','23514','40001','40P01'].includes(error.code))return fail(409);
  return error;
}
/** Moderator operations (spaces, reports) run in their own transaction after a
 * database-derived owner/admin check. Member operations receive the `query` of
 * the access-decision transaction, so every read and write follows that decision.
 */
export class CommunityRepository {
  #db;#userId;
  constructor(db,userId) {if(!(db instanceof TenantDatabase))throw Error('Tenant database required');this.#db=db;this.#userId=userId;}
  async #admin(hubId,operation) {
    try {
      return await this.#db.withSnapshot({hubId,userId:this.#userId,orgIds:[],isStaff:false},async tx=>{
        if(!this.#userId||!(await tx.query('SELECT app.is_hub_admin() AS allowed')).rows[0].allowed)throw fail(404);
        // Staff see company spaces; set only after the check above.
        await tx.query("SELECT set_config('app.is_staff','true',true)");
        return operation(tx);
      });
    }catch(error){throw mapError(error);}
  }
  async createSpace(hubId,input) {
    const title=body(input.title,120).trim(),description=input.description===undefined?'':body(input.description||' ',2000).trim();
    if(!['hub','tier','company'].includes(input.visibility)||(input.visibility==='company')!==uuid.test(input.companyOrg??''))throw fail(400);
    return this.#admin(hubId,async tx=>{
      const spaceId=randomUUID(),boundaryId=randomUUID();
      await tx.query('INSERT INTO tenancy.boundaries(hub_id,id,company_org) VALUES($1,$2,$3)',[hubId,boundaryId,input.visibility==='company'?input.companyOrg:null]);
      await tx.query('INSERT INTO community.spaces(hub_id,id,boundary_id,title,description,visibility) VALUES($1,$2,$3,$4,$5,$6)',
        [hubId,spaceId,boundaryId,title,description,input.visibility]);
      return {id:spaceId,title,description,visibility:input.visibility,status:'active'};
    });
  }
  async adminSpaces(hubId) {
    return this.#admin(hubId,async tx=>(await tx.query(`SELECT s.id,s.title,s.description,s.visibility,s.status,b.company_org,
      (SELECT count(*)::int FROM community.posts p WHERE p.space_id=s.id) AS posts
      FROM community.spaces s JOIN tenancy.boundaries b ON b.hub_id=s.hub_id AND b.id=s.boundary_id ORDER BY s.created_at,s.id`)).rows);
  }
  async updateSpace(hubId,spaceId,input) {
    id(spaceId);
    const title=input.title===undefined?null:body(input.title,120).trim(),description=input.description===undefined?null:String(input.description);
    if((description!==null&&description.length>2000)||(input.status!==undefined&&!['active','archived'].includes(input.status)))throw fail(400);
    return this.#admin(hubId,async tx=>{
      const row=(await tx.query(`UPDATE community.spaces SET title=coalesce($2,title),description=coalesce($3,description),status=coalesce($4,status)
        WHERE id=$1 RETURNING id,title,description,visibility,status`,[spaceId,title,description,input.status??null])).rows[0];
      if(!row)throw fail(404);return row;
    });
  }
  async reports(hubId,{status='open'}={}) {
    if(!['open','dismissed','actioned'].includes(status))throw fail(400);
    return this.#admin(hubId,async tx=>(await tx.query(`SELECT r.id,r.target_type,r.target_id,r.reporter_id,r.reason,r.status,r.resolution,r.created_at,
      s.title AS space_title,coalesce(p.body,c.body) AS target_body,coalesce(p.author_id,c.author_id) AS target_author,coalesce(p.status,c.status) AS target_status
      FROM community.reports r JOIN community.spaces s ON s.hub_id=r.hub_id AND s.id=r.space_id
      LEFT JOIN community.posts p ON r.target_type='post' AND p.hub_id=r.hub_id AND p.id=r.target_id
      LEFT JOIN community.comments c ON r.target_type='comment' AND c.hub_id=r.hub_id AND c.id=r.target_id
      WHERE r.status=$1 ORDER BY r.created_at,r.id LIMIT 200`,[status])).rows);
  }
  async resolve(hubId,reportId,action) {
    id(reportId);
    if(!['dismiss','hide','remove','suspend'].includes(action))throw fail(400);
    return this.#admin(hubId,async tx=>({resolution:(await tx.query('SELECT app.resolve_report($1,$2) AS r',[reportId,action])).rows[0].r}));
  }

  // Member operations: `query` belongs to the access-decision transaction.
  static async feed(query,spaceId,userId,{before=null,limit=20}={}) {
    const size=Number(limit);
    if(!Number.isInteger(size)||size<1||size>50)throw fail(400);
    let cursor=null;
    if(before!==null) {
      try{cursor=JSON.parse(Buffer.from(String(before),'base64url').toString('utf8'));}catch{throw fail(400);}
      if(typeof cursor?.at!=='string'||cursor.at.length>64||!uuid.test(cursor?.id??''))throw fail(400);
    }
    const rows=(await query(`SELECT p.id,p.author_id,p.body,p.created_at,p.created_at::text AS at_key,
      (SELECT count(*)::int FROM community.comments c WHERE c.post_id=p.id AND c.status='visible') AS comments,
      (SELECT coalesce(jsonb_object_agg(kind,n),'{}') FROM (SELECT kind,count(*)::int AS n FROM community.reactions r WHERE r.post_id=p.id GROUP BY kind) k) AS reactions,
      (SELECT coalesce(array_agg(kind),'{}') FROM community.reactions r WHERE r.post_id=p.id AND r.user_id=$2) AS mine
      FROM community.posts p WHERE p.space_id=$1 AND p.status='visible'
        AND ($3::timestamptz IS NULL OR (p.created_at,p.id)<($3::timestamptz,$4::uuid))
      ORDER BY p.created_at DESC,p.id DESC LIMIT $5`,[spaceId,userId,cursor?.at??null,cursor?.id??null,size+1])).rows;
    const page=rows.slice(0,size),last=page.at(-1);
    return {posts:page.map(({at_key,...p})=>p),next:rows.length>size?Buffer.from(JSON.stringify({at:last.at_key,id:last.id})).toString('base64url'):null};
  }
  static async post(query,postId,userId) {
    const post=(await query(`SELECT p.id,p.space_id,p.author_id,p.body,p.created_at,
      (SELECT coalesce(jsonb_object_agg(kind,n),'{}') FROM (SELECT kind,count(*)::int AS n FROM community.reactions r WHERE r.post_id=p.id GROUP BY kind) k) AS reactions,
      (SELECT coalesce(array_agg(kind),'{}') FROM community.reactions r WHERE r.post_id=p.id AND r.user_id=$2) AS mine
      FROM community.posts p WHERE p.id=$1 AND p.status='visible'`,[postId,userId])).rows[0];
    if(!post)throw fail(404);
    const comments=(await query(`SELECT id,author_id,body,created_at FROM community.comments WHERE post_id=$1 AND status='visible'
      ORDER BY created_at,id LIMIT 500`,[postId])).rows;
    return {post,comments};
  }
  static async createPost(query,{hubId,spaceId,userId,text}) {
    const postId=randomUUID();
    const inserted=await query(`INSERT INTO community.posts(hub_id,id,space_id,boundary_id,author_id,body)
      SELECT hub_id,$2,id,boundary_id,$3,$4 FROM community.spaces WHERE hub_id=$1 AND id=$5 AND status='active'`,[hubId,postId,userId,body(text,10000),spaceId]);
    if(!inserted.rowCount)throw fail(409); // Archived spaces are read-only, even for staff.
    return {id:postId};
  }
  static async createComment(query,{hubId,postId,userId,text}) {
    const commentId=randomUUID();
    const inserted=await query(`INSERT INTO community.comments(hub_id,id,post_id,space_id,boundary_id,author_id,body)
      SELECT hub_id,$2,id,space_id,boundary_id,$3,$4 FROM community.posts WHERE hub_id=$1 AND id=$5 AND status='visible'`,[hubId,commentId,userId,body(text,5000),postId]);
    if(!inserted.rowCount)throw fail(404);
    return {id:commentId};
  }
  static async react(query,{hubId,postId,userId,kind,on}) {
    if(!reactionKinds.includes(kind))throw fail(400);
    if(on)await query(`INSERT INTO community.reactions(hub_id,post_id,space_id,boundary_id,user_id,kind)
      SELECT hub_id,id,space_id,boundary_id,$3,$4 FROM community.posts WHERE hub_id=$1 AND id=$2 AND status='visible'
      ON CONFLICT DO NOTHING`,[hubId,postId,userId,kind]);
    else await query('DELETE FROM community.reactions WHERE hub_id=$1 AND post_id=$2 AND user_id=$3 AND kind=$4',[hubId,postId,userId,kind]);
    return {kind,on};
  }
  static async withdraw(query,{type,targetId,userId}) {
    const table=type==='post'?'community.posts':'community.comments';
    const result=await query(`UPDATE ${table} SET status='removed' WHERE id=$1 AND author_id=$2 AND status='visible'`,[targetId,userId]);
    if(!result.rowCount)throw fail(404);
    return {removed:true};
  }
  static async report(query,{hubId,spaceId,type,targetId,userId,reason}) {
    if(!['post','comment'].includes(type))throw fail(400);
    const table=type==='post'?'community.posts':'community.comments';
    const target=(await query(`SELECT boundary_id FROM ${table} WHERE hub_id=$1 AND id=$2 AND space_id=$3 AND status='visible'`,[hubId,targetId,spaceId])).rows[0];
    if(!target)throw fail(404);
    // Repeated flags by the same person on the same target count once.
    await query(`INSERT INTO community.reports(hub_id,id,space_id,boundary_id,target_type,target_id,reporter_id,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(hub_id,target_type,target_id,reporter_id) WHERE status='open' DO NOTHING`,
      [hubId,randomUUID(),spaceId,target.boundary_id,type,targetId,userId,body(reason,1000)]);
    return {reported:true};
  }
}
export { mapError as communityError };
