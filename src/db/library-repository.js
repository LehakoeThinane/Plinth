import { randomUUID } from 'node:crypto';
import { TenantDatabase } from './tenant.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=status=>Object.assign(new Error('Library request rejected'),{status});
const visibilities=['public','members','tier','entitled'],topicPattern=/^[a-z0-9]+(-[a-z0-9]+)*$/;
function text(value,max,required=true) {
  if(value===undefined&&!required)return undefined;
  if(typeof value!=='string'||(required&&!value.trim())||value.length>max)throw fail(400);
  return required?value.trim():value;
}
function topics(value) {
  if(value===undefined)return undefined;
  if(!Array.isArray(value)||value.length>5||value.some(t=>typeof t!=='string'||t.length>40||!topicPattern.test(t)))throw fail(400);
  return [...new Set(value)];
}
/** Library authoring for active hub owners/admins, and the public listing.
 * Listings carry previews only; full items are opened through AccessService.
 */
export class LibraryRepository {
  #db;#userId;
  constructor(db,userId=null) {if(!(db instanceof TenantDatabase))throw Error('Tenant database required');this.#db=db;this.#userId=userId;}
  async #run(hubId,admin,operation) {
    try {
      return await this.#db.withSnapshot({hubId,userId:admin?this.#userId:null,orgIds:[],isStaff:false},async tx=>{
        if(admin&&(!this.#userId||!(await tx.query('SELECT app.is_hub_admin() AS allowed')).rows[0].allowed))throw fail(404);
        return operation(tx);
      });
    }catch(error) {
      if(error.code==='42501')throw fail(404);
      if(['23503','22023','22P02'].includes(error.code))throw fail(400);
      if(['23505','23514','40001','40P01'].includes(error.code))throw fail(409);
      throw error;
    }
  }
  // Buyer-only items must point at a paid product on the shelf, never a company product.
  async #requiredProduct(tx,visibility,productId) {
    if(visibility!=='entitled')return null;
    if(!uuid.test(productId??''))throw fail(400);
    const product=(await tx.query("SELECT id FROM catalogue.products WHERE id=$1 AND access_mode='entitled' AND visibility<>'company'",[productId])).rows[0];
    if(!product)throw fail(400);
    return product.id;
  }
  async list(hubId) {
    return this.#run(hubId,true,async tx=>(await tx.query(`SELECT id,type,title,visibility,topics,status,published_at,updated_at
      FROM library.items ORDER BY created_at DESC,id LIMIT 200`)).rows);
  }
  async create(hubId,input) {
    const fields={title:text(input.title,200),summary:text(input.summary??'',2000,false)??'',body:text(input.body??'',50000,false)??'',
      visibility:input.visibility,topics:topics(input.topics??[])};
    if(!visibilities.includes(fields.visibility))throw fail(400);
    return this.#run(hubId,true,async tx=>{
      const id=randomUUID(),required=await this.#requiredProduct(tx,fields.visibility,input.requiredProductId);
      await tx.query(`INSERT INTO library.items(hub_id,id,title,summary,body,visibility,required_product_id,topics)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[hubId,id,fields.title,fields.summary,fields.body,fields.visibility,required,fields.topics]);
      return {id,...fields,requiredProductId:required,status:'draft'};
    });
  }
  async get(hubId,itemId) {
    if(!uuid.test(itemId??''))throw fail(400);
    return this.#run(hubId,true,async tx=>{
      const item=(await tx.query('SELECT * FROM library.items WHERE id=$1',[itemId])).rows[0];
      if(!item)throw fail(404);return item;
    });
  }
  async update(hubId,itemId,input) {
    if(!uuid.test(itemId??''))throw fail(400);
    const title=text(input.title,200,false),summary=text(input.summary,2000,false),body=text(input.body,50000,false),list=topics(input.topics);
    if(input.visibility!==undefined&&!visibilities.includes(input.visibility))throw fail(400);
    return this.#run(hubId,true,async tx=>{
      const current=(await tx.query('SELECT visibility,required_product_id FROM library.items WHERE id=$1 FOR UPDATE',[itemId])).rows[0];
      if(!current)throw fail(404);
      const visibility=input.visibility??current.visibility;
      const required=input.visibility!==undefined||input.requiredProductId!==undefined?
        await this.#requiredProduct(tx,visibility,input.requiredProductId??current.required_product_id):current.required_product_id;
      return (await tx.query(`UPDATE library.items SET title=coalesce($2,title),summary=coalesce($3,summary),body=coalesce($4,body),
        topics=coalesce($5,topics),visibility=$6,required_product_id=$7 WHERE id=$1
        RETURNING id,title,summary,visibility,required_product_id,topics,status`,
        [itemId,title??null,summary??null,body??null,list??null,visibility,required])).rows[0];
    });
  }
  async setStatus(hubId,itemId,status) {
    if(!uuid.test(itemId??'')||!['published','archived'].includes(status))throw fail(400);
    return this.#run(hubId,true,async tx=>{
      const result=await tx.query('UPDATE library.items SET status=$2 WHERE id=$1 AND status<>$2 RETURNING id,status,published_at',[itemId,status]);
      if(!result.rows.length)throw fail(409);return result.rows[0];
    });
  }
  /** Public browse: published previews only, newest first, filterable by topic. */
  async browse(hubId,{topic=null,before=null,limit=24}={}) {
    const size=Number(limit);
    if(!Number.isInteger(size)||size<1||size>100||(topic!==null&&(typeof topic!=='string'||!topicPattern.test(topic)||topic.length>40)))throw fail(400);
    let cursor=null;
    if(before!==null) {
      try{cursor=JSON.parse(Buffer.from(String(before),'base64url').toString('utf8'));}catch{throw fail(400);}
      if(typeof cursor?.at!=='string'||cursor.at.length>64||!uuid.test(cursor?.id??''))throw fail(400);
    }
    return this.#run(hubId,false,async tx=>{
      const rows=(await tx.query(`SELECT i.id,i.type,i.title,i.summary,i.visibility,i.topics,i.published_at,i.published_at::text AS at_key,p.title AS product_title
        FROM library.items i LEFT JOIN catalogue.products p ON p.hub_id=i.hub_id AND p.id=i.required_product_id
        WHERE i.status='published' AND (i.required_product_id IS NULL OR p.status='published') AND ($1::text IS NULL OR $1=ANY(i.topics))
          AND ($2::timestamptz IS NULL OR (i.published_at,i.id)<($2::timestamptz,$3::uuid))
        ORDER BY i.published_at DESC,i.id DESC LIMIT $4`,[topic,cursor?.at??null,cursor?.id??null,size+1])).rows;
      const page=rows.slice(0,size),last=page.at(-1);
      return {items:page.map(({at_key,...row})=>row),
        next:rows.length>size?Buffer.from(JSON.stringify({at:last.at_key,id:last.id})).toString('base64url'):null};
    });
  }
}
