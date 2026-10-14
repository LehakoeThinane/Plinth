import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { TenantDatabase } from '../src/db/tenant.js';
import { CatalogueRepository } from '../src/db/catalogue-repository.js';
import { auditPolicies } from '../src/db/policy-audit.js';
export async function catalogueChecks({admin,app,db,hubId,otherHub,userA,userB,companyOrg,check,base,fetch,slug,embeddedMode}) {
  const owner=new CatalogueRepository(db,userA),learner=new CatalogueRepository(db,userB),shelf=new CatalogueRepository(db);
  const as=(user,isStaff,sql,params)=>db.withSnapshot({hubId,userId:user,orgIds:[],isStaff},tx=>tx.query(sql,params));
  const course={type:'course',title:'Speak <script>up</script>',summary:'Presence & voice',visibility:'public'};
  async function product(input,{lessons=1,plan=true}={}) {
    const created=await owner.create(hubId,input),module=await owner.addModule(hubId,created.id,{title:'Module'});
    for(let i=0;i<lessons;i++)await owner.addLesson(hubId,created.id,{moduleId:module.id,title:'Lesson '+i});
    if(plan)await owner.addPlan(hubId,created.id,{model:'once_off',amountCents:50000});
    return {...created,moduleId:module.id};
  }
  await check('catalogue authoring requires an active hub admin and the database enforces it',async()=>{
    for(const repository of [learner,shelf]) {
      await assert.rejects(repository.list(hubId),{status:404});await assert.rejects(repository.create(hubId,course),{status:404});
    }
    await assert.rejects(owner.list(otherHub),{status:404});
    // A forged staff flag without an owner/admin membership cannot create catalogue rows.
    await assert.rejects(as(userB,true,'INSERT INTO tenancy.boundaries(hub_id,id) VALUES($1,$2)',[hubId,randomUUID()]),{code:'42501'});
    const existing=(await owner.create(hubId,{...course,title:'Existing'})).id;
    const boundary=(await admin.query('SELECT boundary_id FROM catalogue.products WHERE id=$1',[existing])).rows[0].boundary_id;
    await assert.rejects(as(userB,true,"INSERT INTO catalogue.plans(hub_id,id,product_id,boundary_id,model,amount_cents) VALUES($1,$2,$3,$4,'once_off',100)",[hubId,randomUUID(),existing,boundary]),{code:'42501'});
    await assert.rejects(as(userB,true,"INSERT INTO catalogue.modules(hub_id,id,product_id,boundary_id,position,title) VALUES($1,$2,$3,$4,0,'Forged')",[hubId,randomUUID(),existing,boundary]),{code:'42501'});
    for(const statement of ['DROP POLICY company_scope ON catalogue.plans','DROP POLICY company_scope ON catalogue.modules']) {
      const c=await admin.connect();
      try{await c.query('BEGIN');await c.query(statement);await assert.rejects(auditPolicies(c),/Unsafe tenant policies/);}
      finally{await c.query('ROLLBACK');c.release();}
    }
  });
  let live,companyProduct;
  await check('a drafted product with modules, lessons and prices reaches the shelf only when published',async()=>{
    const created=await owner.create(hubId,course);
    const first=await owner.addModule(hubId,created.id,{title:'Foundations'}),second=await owner.addModule(hubId,created.id,{title:'Practice'});
    await owner.addLesson(hubId,created.id,{moduleId:first.id,title:'Breathing',previewAvailable:true});
    await owner.addLesson(hubId,created.id,{moduleId:second.id,title:'Rehearsal'});
    await owner.addPlan(hubId,created.id,{model:'once_off',amountCents:125000});
    await owner.addPlan(hubId,created.id,{model:'subscription',amountCents:20000,interval:'month'});
    assert.ok(!(await shelf.shelf(hubId)).some(p=>p.id===created.id));await assert.rejects(shelf.page(hubId,created.id),{status:404});
    assert.equal((await owner.publish(hubId,created.id)).lessonsPublished,2);
    const listed=(await shelf.shelf(hubId)).find(p=>p.id===created.id);assert.equal(listed.from_cents,20000);
    const page=await shelf.page(hubId,created.id);
    assert.deepEqual(page.modules.map(m=>[m.title,m.lessons.map(l=>[l.title,l.preview_available])]),[['Foundations',[['Breathing',true]]],['Practice',[['Rehearsal',false]]]]);
    assert.deepEqual(page.plans.map(p=>[p.model,p.amount_cents,p.billing_interval]).sort(),[['once_off',125000,null],['subscription',20000,'month']]);
    assert.ok((await owner.get(hubId,created.id)).modules.every(m=>m.lessons.every(l=>l.status==='published')));
    live=created;
  });
  await check('publishing needs lessons and a price; prices and published access cannot be rewritten',async()=>{
    const empty=await owner.create(hubId,{...course,title:'Empty'});await assert.rejects(owner.publish(hubId,empty.id),{status:409});
    const unpriced=await product({...course,title:'Unpriced'},{plan:false});await assert.rejects(owner.publish(hubId,unpriced.id),{status:409});
    const free=await product({...course,title:'Free',accessMode:'open'},{plan:false});await owner.publish(hubId,free.id);
    await assert.rejects(owner.update(hubId,live.id,{accessMode:'open'}),{status:409});
    assert.equal((await owner.update(hubId,live.id,{title:'Speak up, revised'})).title,'Speak up, revised');
    for(const plan of [{model:'subscription',amountCents:1000},{model:'once_off',amountCents:50},{model:'per_seat',amountCents:1000,interval:'month'},{model:'gift',amountCents:1000}])
      await assert.rejects(owner.addPlan(hubId,live.id,plan),{status:400});
    const solo=await product({...course,title:'Solo price'});await owner.publish(hubId,solo.id);
    const [only]=(await owner.get(hubId,solo.id)).plans;
    await assert.rejects(owner.retirePlan(hubId,solo.id,only.id),{status:409});
    assert.equal((await owner.get(hubId,solo.id)).plans[0].status,'active');
    await owner.addPlan(hubId,solo.id,{model:'once_off',amountCents:60000});await owner.retirePlan(hubId,solo.id,only.id);
    assert.deepEqual((await shelf.page(hubId,solo.id)).plans.map(p=>p.amount_cents),[60000]);
    await assert.rejects(as(userA,true,'UPDATE catalogue.plans SET amount_cents=1 WHERE id=$1',[only.id]),{code:'42501'});
    await assert.rejects(as(userA,true,"UPDATE catalogue.plans SET status='active' WHERE id=$1",[only.id]),{code:'23514'});
    await assert.rejects(admin.query('UPDATE catalogue.products SET marketplace_listed=true WHERE id=$1',[solo.id]),{code:'23514'});
  });
  await check('concurrent price retirements cannot leave a live paid product unpurchasable',async()=>{
    const pool=embeddedMode?null:new pg.Pool({connectionString:process.env.DATABASE_URL,max:2});
    const concurrent=pool?new CatalogueRepository(new TenantDatabase(pool),userA):owner;
    try {
      const target=await product({...course,title:'Two prices'});await owner.addPlan(hubId,target.id,{model:'once_off',amountCents:70000});
      await owner.publish(hubId,target.id);
      const [one,two]=(await owner.get(hubId,target.id)).plans;
      const results=await Promise.allSettled([owner.retirePlan(hubId,target.id,one.id),concurrent.retirePlan(hubId,target.id,two.id)]);
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
      assert.equal((await shelf.page(hubId,target.id)).plans.length,1);
    }finally{if(pool)await pool.end();}
  });
  await check('company products stay off the shelf, refuse prices and are hidden by the boundary',async()=>{
    const company={...course,title:'Absa leadership',visibility:'company',companyOrg};
    await assert.rejects(owner.create(hubId,{...company,companyOrg:randomUUID()}),{status:400});
    await assert.rejects(owner.create(hubId,{...company,accessMode:'open'}),{status:400});
    const created=await product(company,{plan:false});companyProduct=created.id;
    await assert.rejects(owner.addPlan(hubId,created.id,{model:'per_seat',amountCents:10000}),{status:409});
    await owner.publish(hubId,created.id);
    assert.ok(!(await shelf.shelf(hubId)).some(p=>p.id===created.id));await assert.rejects(shelf.page(hubId,created.id),{status:404});
    assert.equal((await as(userB,false,'SELECT id FROM catalogue.products WHERE id=$1',[created.id])).rows.length,0);
    assert.equal((await as(userB,false,'SELECT id FROM catalogue.lessons WHERE product_id=$1',[created.id])).rows.length,0);
    assert.equal((await fetch(base+'/h/'+slug+'/products/'+created.id)).status,404);
  });
  await check('a lesson cannot use another product\'s module and other hubs cannot see products',async()=>{
    const other=await owner.create(hubId,{...course,title:'Other'});
    await assert.rejects(owner.addLesson(hubId,other.id,{moduleId:(await owner.get(hubId,live.id)).modules[0].id,title:'Smuggled'}),{status:400});
    await assert.rejects(shelf.page(otherHub,live.id),{status:404});
    assert.ok(!(await shelf.shelf(otherHub)).some(p=>p.id===live.id));
  });
  await check('HTTP catalogue authoring is admin-only and CSRF protected; the shelf is public and escaped',async()=>{
    const route=base+'/v1/hubs/'+hubId+'/catalogue/products',bearer={authorization:'Bearer learner-a'};
    assert.equal((await fetch(route,{method:'POST',headers:{authorization:'Bearer learner-b'},body:JSON.stringify(course)})).status,404);
    assert.equal((await fetch(route,{method:'POST',body:JSON.stringify(course)})).status,401);
    const session=await fetch(base+'/v1/hubs/'+hubId+'/session',{method:'POST',headers:{...bearer,host:'learn-new.example',origin:'https://learn-new.example'}});
    const cookie=session.headers.get('set-cookie').split(';')[0],csrf=(await session.json()).csrfToken,browser={cookie,host:'learn-new.example',origin:'https://learn-new.example'};
    assert.equal((await fetch(route,{method:'POST',headers:browser,body:JSON.stringify(course)})).status,403);
    const created=await fetch(route,{method:'POST',headers:{...browser,'x-csrf-token':csrf},body:JSON.stringify({...course,title:'HTTP course'})});
    assert.equal(created.status,201);const id=(await created.json()).id;
    const module=await (await fetch(route+'/'+id+'/modules',{method:'POST',headers:bearer,body:JSON.stringify({title:'One'})})).json();
    assert.equal((await fetch(route+'/'+id+'/lessons',{method:'POST',headers:bearer,body:JSON.stringify({moduleId:module.id,title:'Intro'})})).status,201);
    const plan=await (await fetch(route+'/'+id+'/plans',{method:'POST',headers:bearer,body:JSON.stringify({model:'once_off',amountCents:99900})})).json();
    assert.equal((await fetch(route+'/'+id+'/publish',{method:'POST',headers:bearer})).status,200);
    assert.equal((await fetch(route+'/'+id+'/plans/'+plan.id,{method:'DELETE',headers:bearer})).status,409);
    assert.equal((await fetch(route+'/'+id,{method:'PATCH',headers:bearer,body:JSON.stringify({accessMode:'open'})})).status,409);
    assert.equal((await fetch(route,{headers:bearer})).status,200);
    const listing=await fetch(base+'/v1/hubs/'+hubId+'/products');assert.equal(listing.status,200);
    assert.ok((await listing.json()).products.some(p=>p.id===id));
    const storefront=await (await fetch(base+'/h/'+slug)).text();
    assert.ok(storefront.includes('Speak up, revised'));assert.ok(storefront.includes('From R200.00'));assert.ok(!storefront.includes('<script>up'));
    const page=await fetch(base+'/h/'+slug+'/products/'+live.id);assert.equal(page.status,200);
    const html=await page.text();assert.ok(html.includes('R1 250.00'));assert.ok(html.includes('R200.00 per month'));assert.ok(html.includes('Breathing · free preview'));
    assert.equal((await fetch(base+'/v1/hubs/'+hubId+'/products/'+randomUUID())).status,404);
  });
  await check('admin product screens are owner/admin-only, escaped and reflect structure and prices',async()=>{
    const host='learn-new.example',pages=base+'/h/'+slug+'/admin/products';
    const sessionFor=async token=>(await fetch(base+'/v1/hubs/'+hubId+'/session',{method:'POST',headers:{authorization:'Bearer '+token,host,origin:'https://'+host}})).headers.get('set-cookie').split(';')[0];
    const ownerCookie=await sessionFor('learner-a'),learnerCookie=await sessionFor('learner-b');
    await owner.create(hubId,course);
    const anonymous=await fetch(pages,{headers:{host}});assert.equal(anonymous.status,303);assert.equal(anonymous.headers.get('location'),'/h/'+slug+'/sign-in?view=admin');
    assert.equal((await fetch(pages,{headers:{host,cookie:learnerCookie}})).status,404);
    assert.equal((await fetch(pages+'/'+live.id,{headers:{host,cookie:learnerCookie}})).status,404);
    const list=await fetch(pages,{headers:{host,cookie:ownerCookie}});assert.equal(list.status,200);
    const listHtml=await list.text();assert.ok(listHtml.includes('id="create-product"'));assert.ok(listHtml.includes('Speak up, revised'));
    assert.ok(listHtml.includes('&lt;script&gt;up&lt;/script&gt;'));assert.ok(!listHtml.includes('<script>up'));
    const editor=await (await fetch(pages+'/'+live.id,{headers:{host,cookie:ownerCookie}})).text();
    for(const text of ['Foundations','Breathing · published · free preview','R1 250.00 once-off','R200.00 per month','id="add-plan"','data-product-id="'+live.id+'"'])assert.ok(editor.includes(text),text);
    assert.ok(!editor.includes('id="publish-product"'));
    const company=await (await fetch(pages+'/'+companyProduct,{headers:{host,cookie:ownerCookie}})).text();
    assert.ok(company.includes('Private to organisation'));assert.ok(!company.includes('id="add-plan"'));
    assert.equal((await fetch(pages+'/'+randomUUID(),{headers:{host,cookie:ownerCookie}})).status,404);
  });
}
