import { randomUUID } from 'node:crypto';
import { TenantDatabase } from './tenant.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=status=>Object.assign(new Error('Catalogue request rejected'),{status});
const types=['course','toolkit','programme'],visibilities=['public','members','company'],modes=['open','members','entitled'];
const models=['once_off','subscription','per_seat'],intervals=['month','year'];
function text(value,max,required=true) {
  if(value===undefined&&!required)return undefined;
  if(typeof value!=='string'||(required&&!value.trim())||value.trim().length>max)throw fail(400);
  return value.trim();
}
const id=value=>{if(typeof value!=='string'||!uuid.test(value))throw fail(400);return value;};
/** Catalogue authoring for active hub owners/admins, and the public shelf.
 * Authority comes from membership rows in the same transaction, never from
 * request data. Company products are visible only through their boundary.
 */
export class CatalogueRepository {
  #db;#userId;
  constructor(db,userId=null) {if(!(db instanceof TenantDatabase))throw Error('Tenant database required');this.#db=db;this.#userId=userId;}
  async #run(hubId,admin,operation) {
    try {
      return await this.#db.withSnapshot({hubId,userId:admin?this.#userId:null,orgIds:[],isStaff:false},async tx=>{
        if(admin) {
          if(!this.#userId||!(await tx.query('SELECT app.is_hub_admin() AS allowed')).rows[0].allowed)throw fail(404);
          // Existing staff write policies trust this flag; it is set only after the check above.
          await tx.query("SELECT set_config('app.is_staff','true',true)");
        }
        return operation(tx);
      });
    }catch(error) {
      if(error.code==='42501')throw fail(404);
      if(error.code==='23503')throw fail(400);
      if(['23505','23514','40001','40P01'].includes(error.code))throw fail(409);
      if(['22023','22P02','23502'].includes(error.code))throw fail(400);
      throw error;
    }
  }
  async #product(tx,productId) {
    const product=(await tx.query(`SELECT p.id,p.type,p.title,p.summary,p.visibility,p.access_mode,p.status,p.boundary_id,
      p.created_at,p.published_at,b.company_org FROM catalogue.products p
      JOIN tenancy.boundaries b ON b.hub_id=p.hub_id AND b.id=p.boundary_id WHERE p.id=$1`,[id(productId)])).rows[0];
    if(!product)throw fail(404);return product;
  }
  // Locking the product row serialises structure, price and publication changes.
  async #lock(tx,productId) {
    const product=await this.#product(tx,productId);
    await tx.query('UPDATE catalogue.products SET updated_at=now() WHERE id=$1',[product.id]);
    return product;
  }
  async #outline(tx,productId,{publishedOnly}) {
    const modules=(await tx.query('SELECT id,position,title FROM catalogue.modules WHERE product_id=$1 ORDER BY position',[productId])).rows;
    // Only the admin view joins lesson bodies; the public outline never carries content.
    const lessons=(await tx.query(`SELECT l.id,l.module_id,l.position,l.title,l.summary,l.status,l.preview_available
      ${publishedOnly?'':',c.body'} FROM catalogue.lessons l
      ${publishedOnly?'':'LEFT JOIN content.lesson_bodies c ON c.hub_id=l.hub_id AND c.lesson_id=l.id'}
      WHERE l.product_id=$1 AND l.module_id IS NOT NULL ${publishedOnly?"AND l.status='published'":''} ORDER BY l.position`,[productId])).rows;
    return modules.map(m=>({...m,lessons:lessons.filter(l=>l.module_id===m.id).map(({module_id,...l})=>l)}));
  }
  #plans(tx,productId,activeOnly) {
    return tx.query(`SELECT id,model,amount_cents,currency,billing_interval,status,created_at FROM catalogue.plans
      WHERE product_id=$1 ${activeOnly?"AND status='active'":''} ORDER BY created_at,id`,[productId]).then(r=>r.rows);
  }

  async list(hubId) {
    return this.#run(hubId,true,async tx=>(await tx.query(`SELECT p.id,p.type,p.title,p.visibility,p.access_mode,p.status,
      p.published_at,b.company_org,
      (SELECT count(*)::int FROM catalogue.lessons l WHERE l.product_id=p.id) AS lessons,
      (SELECT count(*)::int FROM catalogue.plans s WHERE s.product_id=p.id AND s.status='active') AS active_plans
      FROM catalogue.products p JOIN tenancy.boundaries b ON b.hub_id=p.hub_id AND b.id=p.boundary_id
      ORDER BY p.created_at DESC,p.id LIMIT 200`)).rows);
  }
  async create(hubId,input) {
    const fields={type:input.type,title:text(input.title,200),summary:text(input.summary??'',2000,false)??'',
      visibility:input.visibility,accessMode:input.accessMode??'entitled'};
    if(!types.includes(fields.type)||!visibilities.includes(fields.visibility)||!modes.includes(fields.accessMode))throw fail(400);
    // Company products are delivered through seat grants, never free or priced on the shelf.
    if(fields.visibility==='company'&&(fields.accessMode!=='entitled'||!uuid.test(input.companyOrg??'')))throw fail(400);
    const productId=randomUUID(),boundaryId=randomUUID(),companyOrg=fields.visibility==='company'?input.companyOrg:null;
    return this.#run(hubId,true,async tx=>{
      // Each product owns its boundary; children inherit it through foreign keys.
      await tx.query('INSERT INTO tenancy.boundaries(hub_id,id,company_org) VALUES($1,$2,$3)',[hubId,boundaryId,companyOrg]);
      await tx.query(`INSERT INTO catalogue.products(hub_id,id,boundary_id,title,visibility,access_mode,type,summary)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[hubId,productId,boundaryId,fields.title,fields.visibility,fields.accessMode,fields.type,fields.summary]);
      return {id:productId,...fields,companyOrg,status:'draft'};
    });
  }
  async get(hubId,productId) {
    return this.#run(hubId,true,async tx=>{
      const product=await this.#product(tx,productId);
      return {product,modules:await this.#outline(tx,product.id,{publishedOnly:false}),plans:await this.#plans(tx,product.id,false)};
    });
  }
  async update(hubId,productId,input) {
    const title=text(input.title,200,false),summary=text(input.summary,2000,false),accessMode=input.accessMode;
    if(accessMode!==undefined&&!modes.includes(accessMode))throw fail(400);
    if(title===undefined&&summary===undefined&&accessMode===undefined)throw fail(400);
    return this.#run(hubId,true,async tx=>{
      const product=await this.#lock(tx,productId);
      if(accessMode!==undefined&&product.visibility==='company'&&accessMode!=='entitled')throw fail(400);
      const result=await tx.query(`UPDATE catalogue.products SET title=coalesce($2,title),summary=coalesce($3,summary),
        access_mode=coalesce($4,access_mode) WHERE id=$1 RETURNING id,title,summary,access_mode,status`,[product.id,title??null,summary??null,accessMode??null]);
      return result.rows[0];
    });
  }
  async addModule(hubId,productId,input) {
    const title=text(input.title,200);
    return this.#run(hubId,true,async tx=>{
      const product=await this.#lock(tx,productId),moduleId=randomUUID();
      const position=(await tx.query('SELECT coalesce(max(position)+1,0) AS next FROM catalogue.modules WHERE product_id=$1',[product.id])).rows[0].next;
      await tx.query('INSERT INTO catalogue.modules(hub_id,id,product_id,boundary_id,position,title) VALUES($1,$2,$3,$4,$5,$6)',
        [hubId,moduleId,product.id,product.boundary_id,position,title]);
      return {id:moduleId,position,title};
    });
  }
  async addLesson(hubId,productId,input) {
    const title=text(input.title,200),summary=text(input.summary??'',2000,false)??'',moduleId=id(input.moduleId);
    if(input.previewAvailable!==undefined&&typeof input.previewAvailable!=='boolean')throw fail(400);
    return this.#run(hubId,true,async tx=>{
      const product=await this.#lock(tx,productId),lessonId=randomUUID();
      const position=(await tx.query('SELECT coalesce(max(position)+1,0) AS next FROM catalogue.lessons WHERE module_id=$1',[moduleId])).rows[0].next;
      // The composite foreign key rejects a module from another product.
      await tx.query(`INSERT INTO catalogue.lessons(hub_id,id,product_id,boundary_id,module_id,position,title,summary,preview_available)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[hubId,lessonId,product.id,product.boundary_id,moduleId,position,title,summary,input.previewAvailable??false]);
      return {id:lessonId,moduleId,position,title,status:'draft'};
    });
  }
  async setLessonContent(hubId,productId,lessonId,input) {
    id(lessonId);
    if(typeof input.body!=='string'||input.body.length>50000)throw fail(400);
    return this.#run(hubId,true,async tx=>{
      const product=await this.#lock(tx,productId);
      // The composite key ties the body to this product's lesson and boundary.
      const lesson=(await tx.query('SELECT id FROM catalogue.lessons WHERE id=$1 AND product_id=$2',[lessonId,product.id])).rows[0];
      if(!lesson)throw fail(404);
      await tx.query(`INSERT INTO content.lesson_bodies(hub_id,lesson_id,boundary_id,body) VALUES($1,$2,$3,$4)
        ON CONFLICT(hub_id,lesson_id) DO UPDATE SET body=excluded.body`,[hubId,lessonId,product.boundary_id,input.body]);
      return {lessonId,length:input.body.length};
    });
  }
  async addPlan(hubId,productId,input) {
    const {model,amountCents,interval=null}=input;
    if(!models.includes(model)||!Number.isInteger(amountCents)||amountCents<100||amountCents>100000000||
      (model==='subscription')!==intervals.includes(interval)||(model!=='subscription'&&interval!==null))throw fail(400);
    return this.#run(hubId,true,async tx=>{
      const product=await this.#lock(tx,productId),planId=randomUUID();
      await tx.query(`INSERT INTO catalogue.plans(hub_id,id,product_id,boundary_id,model,amount_cents,billing_interval)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[hubId,planId,product.id,product.boundary_id,model,amountCents,interval]);
      return {id:planId,model,amountCents,interval,status:'active'};
    });
  }
  async retirePlan(hubId,productId,planId) {
    id(planId);
    return this.#run(hubId,true,async tx=>{
      const product=await this.#lock(tx,productId);
      const retired=await tx.query("UPDATE catalogue.plans SET status='retired' WHERE id=$1 AND product_id=$2 AND status='active' RETURNING id",[planId,product.id]);
      if(!retired.rows.length)throw fail(404);
      // A live paid product must stay purchasable.
      if(product.status==='published'&&product.access_mode==='entitled'&&product.visibility!=='company'&&
        !(await this.#plans(tx,product.id,true)).length)throw fail(409);
      return {id:planId,status:'retired'};
    });
  }
  /** Who opened this product's lessons, newest first, keyset-paged by entry id. */
  async opens(hubId,productId,{before=null,limit=50}={}) {
    const size=Number(limit),cursor=before===null?null:Number(before);
    if(!Number.isInteger(size)||size<1||size>200||(cursor!==null&&(!Number.isSafeInteger(cursor)||cursor<1)))throw fail(400);
    return this.#run(hubId,true,async tx=>{
      const product=await this.#product(tx,productId);
      const rows=(await tx.query(`SELECT o.id,o.user_id,o.lesson_id,l.title AS lesson_title,o.user_agent,o.opened_at
        FROM content.lesson_opens o JOIN catalogue.lessons l ON l.hub_id=o.hub_id AND l.id=o.lesson_id
        WHERE l.product_id=$1 AND ($2::bigint IS NULL OR o.id<$2) ORDER BY o.id DESC LIMIT $3`,[product.id,cursor,size+1])).rows;
      const page=rows.slice(0,size).map(r=>({...r,id:Number(r.id)}));
      return {opens:page,next:rows.length>size?page.at(-1).id:null};
    });
  }
  /** Publishes the product (checked by the database) and any draft lessons. */
  async publish(hubId,productId) {
    return this.#run(hubId,true,async tx=>{
      const product=await this.#lock(tx,productId);
      if(product.status==='draft')await tx.query("UPDATE catalogue.products SET status='published' WHERE id=$1",[product.id]);
      const lessons=await tx.query("UPDATE catalogue.lessons SET status='published' WHERE product_id=$1 AND status='draft' RETURNING id",[product.id]);
      return {id:product.id,status:'published',lessonsPublished:lessons.rows.length};
    });
  }

  // Public reads run with no user: RLS hides every company boundary.
  async shelf(hubId) {
    return this.#run(hubId,false,async tx=>(await tx.query(`SELECT p.id,p.type,p.title,p.summary,p.access_mode,
      (SELECT min(amount_cents) FROM catalogue.plans s WHERE s.product_id=p.id AND s.status='active') AS from_cents
      FROM catalogue.products p WHERE p.status='published' AND p.visibility='public'
      ORDER BY p.published_at DESC,p.id LIMIT 100`)).rows);
  }
  async page(hubId,productId) {
    return this.#run(hubId,false,async tx=>{
      const product=(await tx.query(`SELECT id,type,title,summary,access_mode,published_at FROM catalogue.products
        WHERE id=$1 AND status='published' AND visibility='public'`,[id(productId)])).rows[0];
      if(!product)throw fail(404);
      const plans=(await this.#plans(tx,product.id,true)).map(({status,created_at,...plan})=>plan);
      return {product,modules:await this.#outline(tx,product.id,{publishedOnly:true}),plans};
    });
  }
}
