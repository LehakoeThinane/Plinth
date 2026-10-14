import { randomUUID } from 'node:crypto';
import { TenantDatabase } from './tenant.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=status=>Object.assign(new Error('Messaging request rejected'),{status});
const text=(value,max)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw fail(400);return value;};
const id=value=>{if(typeof value!=='string'||!uuid.test(value))throw fail(400);return value;};
const statuses=['open','in_discussion','closed'];
/** Enquiries and their conversations for one verified person. Row-level
 * security decides who reads and writes: the requester, and hub owners/admins
 * for enquiry conversations only. A closed enquiry is read-only.
 */
export class MessagingRepository {
  #db;#userId;
  constructor(db,userId) {if(!(db instanceof TenantDatabase))throw Error('Tenant database required');this.#db=db;this.#userId=userId;}
  async #run(hubId,operation) {
    if(!this.#userId)throw fail(401);
    try {
      return await this.#db.withSnapshot({hubId,userId:this.#userId,orgIds:[],isStaff:false},async tx=>
        operation(tx,(await tx.query('SELECT app.is_hub_admin() AS admin')).rows[0].admin));
    }catch(error) {
      if(error.status)throw error;
      if(error.code==='42501')throw fail(404);
      if(['23503','22023','22P02'].includes(error.code))throw fail(400);
      if(['23505','23514','40001','40P01'].includes(error.code))throw fail(409);
      throw error;
    }
  }
  async createEnquiry(hubId,input) {
    const subject=text(input.subject,200).trim(),need=text(input.need,5000);
    if(input.requesterOrg!==undefined&&input.requesterOrg!==null)id(input.requesterOrg);
    return this.#run(hubId,async tx=>{
      // A company can be named only by someone who belongs to it (the database checks too).
      if(input.requesterOrg&&!(await tx.query("SELECT 1 FROM identity.org_members WHERE user_id=$1 AND org_id=$2 AND status='active'",[this.#userId,input.requesterOrg])).rows.length)throw fail(400);
      const enquiryId=randomUUID(),conversationId=randomUUID();
      // Order matters: the enquiry claims a fresh conversation, then its requester
      // may join it. Inserts avoid RETURNING until the rows are readable.
      await tx.query("INSERT INTO messaging.conversations(hub_id,id,type) VALUES($1,$2,'enquiry')",[hubId,conversationId]);
      await tx.query('INSERT INTO messaging.enquiries(hub_id,id,conversation_id,requester_id,requester_org,subject) VALUES($1,$2,$3,$4,$5,$6)',
        [hubId,enquiryId,conversationId,this.#userId,input.requesterOrg??null,subject]);
      await tx.query("INSERT INTO messaging.participants(hub_id,conversation_id,user_id,role,last_read_at) VALUES($1,$2,$3,'requester',now())",[hubId,conversationId,this.#userId]);
      await tx.query('INSERT INTO messaging.messages(hub_id,id,conversation_id,sender_id,client_id,body) VALUES($1,$2,$3,$4,$5,$6)',
        [hubId,randomUUID(),conversationId,this.#userId,randomUUID(),need]);
      return {id:enquiryId,conversationId,status:'open'};
    });
  }
  /** The provider inbox for owners/admins; the requester's own enquiries otherwise. */
  async enquiries(hubId) {
    return this.#run(hubId,async(tx,admin)=>({provider:admin,enquiries:(await tx.query(`SELECT e.id,e.conversation_id,e.subject,e.status,e.requester_id,e.requester_org,e.created_at,
      (SELECT max(m.created_at) FROM messaging.messages m WHERE m.hub_id=e.hub_id AND m.conversation_id=e.conversation_id) AS last_message_at,
      (SELECT count(*)::int FROM messaging.messages m WHERE m.hub_id=e.hub_id AND m.conversation_id=e.conversation_id AND m.sender_id<>$1
        AND m.created_at>coalesce((SELECT p.last_read_at FROM messaging.participants p WHERE p.hub_id=e.hub_id AND p.conversation_id=e.conversation_id AND p.user_id=$1),'-infinity')) AS unread
      FROM messaging.enquiries e ORDER BY last_message_at DESC NULLS LAST,e.id LIMIT 200`,[this.#userId])).rows}));
  }
  async enquiry(hubId,enquiryId) {
    id(enquiryId);
    return this.#run(hubId,async(tx,admin)=>{
      const enquiry=(await tx.query('SELECT id,conversation_id,subject,status,requester_id,requester_org,created_at FROM messaging.enquiries WHERE id=$1',[enquiryId])).rows[0];
      if(!enquiry)throw fail(404);
      return {provider:admin,enquiry,...await this.#history(tx,enquiry.conversation_id,{})};
    });
  }
  // History loads backwards from the latest; each page is returned oldest first.
  async #history(tx,conversationId,{before=null,limit=50}) {
    const size=Number(limit);
    if(!Number.isInteger(size)||size<1||size>100)throw fail(400);
    let cursor=null;
    if(before!==null) {
      try{cursor=JSON.parse(Buffer.from(String(before),'base64url').toString('utf8'));}catch{throw fail(400);}
      if(typeof cursor?.at!=='string'||cursor.at.length>64||!uuid.test(cursor?.id??''))throw fail(400);
    }
    const rows=(await tx.query(`SELECT m.id,m.sender_id,m.client_id,m.body,m.created_at,m.created_at::text AS at_key,p.role AS sender_role
      FROM messaging.messages m LEFT JOIN messaging.participants p ON p.hub_id=m.hub_id AND p.conversation_id=m.conversation_id AND p.user_id=m.sender_id
      WHERE m.conversation_id=$1 AND ($2::timestamptz IS NULL OR (m.created_at,m.id)<($2::timestamptz,$3::uuid))
      ORDER BY m.created_at DESC,m.id DESC LIMIT $4`,[conversationId,cursor?.at??null,cursor?.id??null,size+1])).rows;
    const page=rows.slice(0,size),oldest=page.at(-1);
    return {messages:page.reverse().map(({at_key,...m})=>m),
      older:rows.length>size?Buffer.from(JSON.stringify({at:oldest.at_key,id:oldest.id})).toString('base64url'):null};
  }
  async history(hubId,conversationId,options={}) {
    id(conversationId);
    return this.#run(hubId,async tx=>{
      if(!(await tx.query('SELECT 1 FROM messaging.conversations WHERE id=$1',[conversationId])).rows.length)throw fail(404);
      return this.#history(tx,conversationId,options);
    });
  }
  async #joinAsProvider(tx,conversationId,admin) {
    if(admin)await tx.query(`INSERT INTO messaging.participants(hub_id,conversation_id,user_id,role)
      SELECT hub_id,id,$2,'provider' FROM messaging.conversations WHERE id=$1 ON CONFLICT DO NOTHING`,[conversationId,this.#userId]);
  }
  /** Idempotent by the client's own message id: a retry returns the same message. */
  async send(hubId,conversationId,input) {
    id(conversationId);const body=text(input.body,5000),clientId=id(input.clientId);
    return this.#run(hubId,async(tx,admin)=>{
      const enquiry=(await tx.query(`SELECT c.id,e.status FROM messaging.conversations c LEFT JOIN messaging.enquiries e
        ON e.hub_id=c.hub_id AND e.conversation_id=c.id WHERE c.id=$1`,[conversationId])).rows[0];
      if(!enquiry)throw fail(404);
      if(enquiry.status==='closed')throw fail(409);
      await this.#joinAsProvider(tx,conversationId,admin);
      await tx.query(`INSERT INTO messaging.messages(hub_id,id,conversation_id,sender_id,client_id,body) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(hub_id,conversation_id,sender_id,client_id) DO NOTHING`,[hubId,randomUUID(),conversationId,this.#userId,clientId,body]);
      // A provider's first reply moves an open enquiry into discussion.
      if(admin)await tx.query("UPDATE messaging.enquiries SET status='in_discussion' WHERE conversation_id=$1 AND status='open'",[conversationId]);
      await tx.query('UPDATE messaging.participants SET last_read_at=now() WHERE conversation_id=$1 AND user_id=$2',[conversationId,this.#userId]);
      return (await tx.query('SELECT id,client_id,body,created_at FROM messaging.messages WHERE conversation_id=$1 AND sender_id=$2 AND client_id=$3',
        [conversationId,this.#userId,clientId])).rows[0];
    });
  }
  async markRead(hubId,conversationId) {
    id(conversationId);
    return this.#run(hubId,async(tx,admin)=>{
      if(!(await tx.query('SELECT 1 FROM messaging.conversations WHERE id=$1',[conversationId])).rows.length)throw fail(404);
      await this.#joinAsProvider(tx,conversationId,admin);
      await tx.query('UPDATE messaging.participants SET last_read_at=now() WHERE conversation_id=$1 AND user_id=$2',[conversationId,this.#userId]);
      return {read:true};
    });
  }
  async setStatus(hubId,enquiryId,status) {
    id(enquiryId);
    if(!statuses.includes(status))throw fail(400);
    return this.#run(hubId,async(tx,admin)=>{
      if(!admin)throw fail(404);
      const row=(await tx.query('UPDATE messaging.enquiries SET status=$2 WHERE id=$1 RETURNING id,status',[enquiryId,status])).rows[0];
      if(!row)throw fail(404);return row;
    });
  }
}
