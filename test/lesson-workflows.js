import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CatalogueRepository } from '../src/db/catalogue-repository.js';
import { PostgresAccessRepository } from '../src/db/access-repository.js';
import { AccessService } from '../src/access.js';
import { MemoryAccessCache } from '../src/cache/memory.js';
import { auditPolicies } from '../src/db/policy-audit.js';
import { LearningRepository } from '../src/db/learning-repository.js';
import { MaintenanceRepository } from '../src/db/maintenance-repository.js';
import { TenantDatabase } from '../src/db/tenant.js';
import pg from 'pg';
export async function lessonChecks({admin,db,hubId,userA,userB,companyOrg,check,base,fetch,slug,testUsers,embeddedMode,maintenance,app}) {
  const owner=new CatalogueRepository(db,userA),cache=new MemoryAccessCache();
  const opener=user=>new AccessService(new PostgresAccessRepository(db,user),cache);
  const open=(user,lessonId)=>opener(user).open({hubId,userId:user,lessonId});
  const body='First paragraph with <b>markup</b>.\nSecond line.\n\nSecond paragraph.';
  async function build(input,lessons) {
    const product=await owner.create(hubId,{type:'course',summary:'',visibility:'public',...input});
    const module=await owner.addModule(hubId,product.id,{title:'Module'}),ids=[];
    for(const lesson of lessons) {
      const created=await owner.addLesson(hubId,product.id,{moduleId:module.id,...lesson});
      await owner.setLessonContent(hubId,product.id,created.id,{body:lesson.title+': '+body});ids.push(created.id);
    }
    if(input.accessMode==='entitled'&&input.visibility!=='company')await owner.addPlan(hubId,product.id,{model:'once_off',amountCents:10000});
    await owner.publish(hubId,product.id);
    return {id:product.id,moduleId:module.id,lessons:ids};
  }
  // Learners: buyer (member + entitlement), member without purchase, company employee.
  const buyer=randomUUID(),member=randomUUID(),employee=randomUUID();testUsers.push(buyer,member,employee);
  await admin.query('INSERT INTO identity.users(id) VALUES($1),($2),($3)',[buyer,member,employee]);
  await admin.query("INSERT INTO tenancy.memberships(hub_id,user_id,role,status) VALUES($1,$2,'member','active'),($1,$3,'member','active'),($1,$4,'member','active')",[hubId,buyer,member,employee]);
  await admin.query("INSERT INTO identity.org_members(user_id,org_id,status) VALUES($1,$2,'active')",[employee,companyOrg]);
  let paid,free,company,members;
  await check('lesson content authoring is admin-only, boundary-scoped and stamped',async()=>{
    paid=await build({title:'Paid course',accessMode:'entitled'},[{title:'Teaser',previewAvailable:true},{title:'Core'}]);
    free=await build({title:'Free course',accessMode:'open'},[{title:'Welcome'}]);
    members=await build({title:'Members course',accessMode:'members'},[{title:'Inside',previewAvailable:true}]);
    company=await build({title:'Company course',accessMode:'entitled',visibility:'company',companyOrg},[{title:'Confidential'}]);
    await admin.query("INSERT INTO access.entitlements(hub_id,id,user_id,target_id) VALUES($1,$2,$3,$4),($1,$5,$3,$6),($1,$7,$8,$6)",
      [hubId,randomUUID(),buyer,paid.id,randomUUID(),company.id,randomUUID(),employee]);
    const stored=(await admin.query('SELECT updated_by FROM content.lesson_bodies WHERE lesson_id=$1',[paid.lessons[1]])).rows[0];assert.equal(stored.updated_by,userA);
    await assert.rejects(new CatalogueRepository(db,userB).setLessonContent(hubId,paid.id,paid.lessons[1],{body:'Forged'}),{status:404});
    await assert.rejects(owner.setLessonContent(hubId,free.id,paid.lessons[1],{body:'Wrong product'}),{status:404});
    await assert.rejects(owner.setLessonContent(hubId,paid.id,paid.lessons[1],{body:'x'.repeat(50001)}),{status:400});
    const boundary=(await admin.query('SELECT boundary_id FROM catalogue.lessons WHERE id=$1',[paid.lessons[0]])).rows[0].boundary_id;
    await assert.rejects(db.withSnapshot({hubId,userId:member,orgIds:[],isStaff:true},tx=>tx.query('INSERT INTO content.lesson_bodies(hub_id,lesson_id,boundary_id,body) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[hubId,paid.lessons[0],boundary,'Forged'])),{code:'42501'});
    assert.equal((await db.withSnapshot({hubId,userId:member,orgIds:[],isStaff:false},tx=>tx.query('SELECT body FROM content.lesson_bodies WHERE lesson_id=$1',[company.lessons[0]]))).rows.length,0);
    const c=await admin.connect();
    try{await c.query('BEGIN');await c.query('DROP POLICY company_scope ON content.lesson_bodies');await assert.rejects(auditPolicies(c),/Unsafe tenant policies/);}
    finally{await c.query('ROLLBACK');c.release();}
  });
  await check('opening a lesson returns content, a locked preview or not found from the same decision',async()=>{
    const allowed=await open(buyer,paid.lessons[1]);assert.equal(allowed.decision,'allowed');assert.ok(allowed.lesson.body.startsWith('Core: '));
    assert.equal(allowed.lesson.productTitle,'Paid course');
    const locked=await open(member,paid.lessons[0]);assert.deepEqual([locked.decision,locked.reason],['locked','purchase']);assert.equal('body' in locked.lesson,false);
    assert.equal((await open(member,paid.lessons[1])).decision,'not_found');
    const anonymous=await open(null,paid.lessons[0]);assert.deepEqual([anonymous.decision,anonymous.reason],['locked','join']);
    assert.equal((await open(null,free.lessons[0])).decision,'allowed');
    assert.equal((await open(member,members.lessons[0])).decision,'allowed');assert.equal((await open(null,members.lessons[0])).reason,'join');
    assert.equal((await open(userA,paid.lessons[1])).decision,'allowed');
  });
  await check('company lessons open only for entitled employees of that company',async()=>{
    assert.equal((await open(employee,company.lessons[0])).decision,'allowed');
    // Entitled but outside the company: both checks must pass.
    assert.equal((await open(buyer,company.lessons[0])).decision,'not_found');
    assert.equal((await open(member,company.lessons[0])).decision,'not_found');assert.equal((await open(null,company.lessons[0])).decision,'not_found');
  });
  await check('revoked entitlements and draft lessons stop content immediately',async()=>{
    const draft=await owner.addLesson(hubId,paid.id,{moduleId:paid.moduleId,title:'Upcoming'});
    await owner.setLessonContent(hubId,paid.id,draft.id,{body:'Not yet'});
    assert.equal((await open(buyer,draft.id)).decision,'not_found');assert.equal((await open(userA,draft.id)).decision,'allowed');
    assert.equal((await open(buyer,paid.lessons[1])).decision,'allowed');
    await admin.query('UPDATE access.entitlements SET revoked=true WHERE user_id=$1 AND target_id=$2',[buyer,paid.id]);
    assert.equal((await open(buyer,paid.lessons[1])).decision,'not_found');
    await admin.query('UPDATE access.entitlements SET revoked=false WHERE user_id=$1 AND target_id=$2',[buyer,paid.id]);
  });
  await check('lesson HTTP routes allow signed-out free lessons, reject bad credentials and escape content',async()=>{
    const api=id=>base+'/v1/hubs/'+hubId+'/lessons/'+id,page=id=>base+'/h/'+slug+'/lessons/'+id;
    const openLesson=await fetch(api(free.lessons[0]));assert.equal(openLesson.status,200);assert.equal((await openLesson.json()).decision,'allowed');
    assert.equal((await fetch(api(paid.lessons[1]))).status,404);
    const teaser=await (await fetch(api(paid.lessons[0]))).json();assert.equal(teaser.decision,'locked');assert.equal(teaser.lesson.body,undefined);
    assert.equal((await fetch(api(paid.lessons[1]),{headers:{authorization:'Bearer learner-a'}})).status,200);
    assert.equal((await fetch(api(free.lessons[0]),{headers:{authorization:'Bearer invalid'}})).status,401);
    assert.equal((await fetch(api(company.lessons[0]))).status,404);assert.equal((await fetch(page(company.lessons[0]))).status,404);
    const freeHtml=await (await fetch(page(free.lessons[0]))).text();
    assert.ok(freeHtml.includes('<p>Welcome: First paragraph with &lt;b&gt;markup&lt;/b&gt;.<br>Second line.</p><p>Second paragraph.</p>'));
    const lockedHtml=await (await fetch(page(paid.lessons[0]))).text();assert.ok(lockedHtml.includes('Join the hub'));assert.ok(!lockedHtml.includes('First paragraph'));
    const product=await (await fetch(base+'/h/'+slug+'/products/'+paid.id)).text();
    assert.ok(product.includes('/lessons/'+paid.lessons[0]));assert.ok(!product.includes('/lessons/'+paid.lessons[1]));
    const route=base+'/v1/hubs/'+hubId+'/catalogue/products/'+paid.id+'/lessons/'+paid.lessons[1]+'/content';
    assert.equal((await fetch(route,{method:'PUT',headers:{authorization:'Bearer learner-b'},body:JSON.stringify({body:'Forged'})})).status,404);
    assert.equal((await fetch(route,{method:'PUT',headers:{authorization:'Bearer learner-a'},body:JSON.stringify({body:'Revised core'})})).status,200);
    assert.equal((await open(buyer,paid.lessons[1])).lesson.body,'Revised core');
  });
  const save=(user,lessonId,update,key=randomUUID(),service=opener(user))=>service.recordProgress({hubId,userId:user,lessonId,update,idempotencyKey:key});
  const step=(baseRevision,position,completed=false)=>({baseRevision,furthestPosition:position,resumePosition:position,completed});
  await check('progress saves only for lessons the learner can open, moves forward and replays retries',async()=>{
    const core=paid.lessons[1],key=randomUUID();
    const first=await save(buyer,core,step(0,0.5),key);assert.deepEqual(first,{progress:{revision:1,furthestPosition:0.5,resumePosition:0.5,completed:false},resumeConflict:false});
    assert.deepEqual(await save(buyer,core,step(0,0.5),key),first);
    assert.equal((await admin.query('SELECT revision::int AS revision FROM content.lesson_progress WHERE user_id=$1 AND lesson_id=$2',[buyer,core])).rows[0].revision,1);
    await assert.rejects(save(buyer,core,step(0,0.9),key),{status:409});
    const second=await save(buyer,core,step(1,0.3,true));
    assert.deepEqual(second.progress,{revision:2,furthestPosition:0.5,resumePosition:0.3,completed:true});
    const stale=await save(buyer,core,step(1,0.9,false));
    assert.deepEqual([stale.resumeConflict,stale.progress.resumePosition,stale.progress.completed,stale.progress.revision],[true,0.3,true,3]);
    assert.equal((await open(buyer,core)).lesson.progress.completed,true);
    await assert.rejects(save(member,core,step(0,0.1)),{status:404});await assert.rejects(save(null,core,step(0,0.1)),{status:401});
    await assert.rejects(save(buyer,company.lessons[0],step(0,0.1)),{status:404});
    assert.equal((await save(employee,company.lessons[0],step(0,1,true))).progress.completed,true);
    for(const [update,key] of [[step(0,-1),randomUUID()],[step(0,10000001),randomUUID()],[{baseRevision:0},randomUUID()],[step(0,0.1),'short'],[step(0,0.1),null]])
      await assert.rejects(save(buyer,paid.lessons[0],update,key),{status:400});
  });
  await check('the database keeps progress per learner and refuses backward or forged writes',async()=>{
    const as=user=>sql=>db.withSnapshot({hubId,userId:user,orgIds:[],isStaff:false},tx=>tx.query(sql,[paid.lessons[1]]));
    await assert.rejects(as(buyer)('UPDATE content.lesson_progress SET furthest_position=0.1,revision=revision+1 WHERE lesson_id=$1'),{code:'23514'});
    await assert.rejects(as(buyer)('UPDATE content.lesson_progress SET completed=false,completed_at=NULL,revision=revision+1 WHERE lesson_id=$1'),{code:'23514'});
    assert.equal((await as(member)('SELECT * FROM content.lesson_progress WHERE lesson_id=$1')).rows.length,0);
    const boundary=(await admin.query('SELECT boundary_id FROM catalogue.lessons WHERE id=$1',[paid.lessons[0]])).rows[0].boundary_id;
    await assert.rejects(db.withSnapshot({hubId,userId:member,orgIds:[],isStaff:false},tx=>tx.query(`INSERT INTO content.lesson_progress(hub_id,user_id,lesson_id,boundary_id,revision,furthest_position,resume_position,completed)
      VALUES($1,$2,$3,$4,1,1,1,false)`,[hubId,buyer,paid.lessons[0],boundary])),{code:'42501'});
    // The buyer has stored requests; another learner sees none of them.
    assert.equal((await db.withSnapshot({hubId,userId:member,orgIds:[],isStaff:false},tx=>tx.query('SELECT * FROM content.progress_requests'))).rows.length,0);
  });
  await check('concurrent saves with one idempotency key apply exactly once',async()=>{
    const pool=embeddedMode?null:new pg.Pool({connectionString:process.env.DATABASE_URL,max:2});
    const other=pool?new AccessService(new PostgresAccessRepository(new TenantDatabase(pool),buyer),new MemoryAccessCache()):opener(buyer);
    try {
      const key=randomUUID(),lesson=paid.lessons[0];
      const before=(await open(buyer,lesson)).lesson.progress?.revision??0;
      const results=await Promise.all([save(buyer,lesson,step(before,0.4),key),save(buyer,lesson,step(before,0.4),key,other)]);
      assert.deepEqual(results[0],results[1]);
      assert.equal((await open(buyer,lesson)).lesson.progress.revision,before+1);
    }finally{if(pool)await pool.end();}
  });
  await check('My learning lists held and started products with progress, never revoked or foreign ones',async()=>{
    const view=async user=>(await new LearningRepository(db,user).learning(hubId)).products;
    const mine=await view(buyer),course=mine.find(p=>p.id===paid.id);
    assert.deepEqual([course.total,course.completed,course.next],[2,1,paid.lessons[0]]);
    assert.ok(!mine.some(p=>p.id===company.id));assert.ok(!mine.some(p=>p.id===free.id));
    assert.ok((await view(employee)).some(p=>p.id===company.id));
    assert.deepEqual(await view(member),[]);
    await save(member,free.lessons[0],step(0,1,true));
    assert.deepEqual((await view(member)).map(p=>[p.id,p.completed,p.next]),[[free.id,1,null]]);
    await admin.query('UPDATE access.entitlements SET revoked=true WHERE user_id=$1 AND target_id=$2',[buyer,paid.id]);
    try{assert.ok(!(await view(buyer)).some(p=>p.id===paid.id));}
    finally{await admin.query('UPDATE access.entitlements SET revoked=false WHERE user_id=$1 AND target_id=$2',[buyer,paid.id]);}
    assert.deepEqual(await view(userB),[]);
  });
  await check('progress and learning HTTP routes need identity, CSRF and an idempotency key',async()=>{
    const route=base+'/v1/hubs/'+hubId+'/lessons/'+paid.lessons[1]+'/progress',body=JSON.stringify(step(0,1,true));
    assert.equal((await fetch(route,{method:'PUT',body})).status,401);
    assert.equal((await fetch(route,{method:'PUT',headers:{authorization:'Bearer learner-a'},body})).status,400);
    assert.equal((await fetch(route,{method:'PUT',headers:{authorization:'Bearer learner-b','idempotency-key':randomUUID()},body})).status,404);
    const saved=await fetch(route,{method:'PUT',headers:{authorization:'Bearer learner-a','idempotency-key':randomUUID()},body});
    assert.equal(saved.status,200);assert.equal((await saved.json()).progress.completed,true);
    const host='learn-new.example',exchange=await fetch(base+'/v1/hubs/'+hubId+'/session',{method:'POST',headers:{authorization:'Bearer learner-a',host,origin:'https://'+host}});
    const cookie=exchange.headers.get('set-cookie').split(';')[0],csrf=(await exchange.json()).csrfToken;
    const browser={host,origin:'https://'+host,cookie,'idempotency-key':randomUUID()};
    assert.equal((await fetch(base+'/v1/hubs/'+hubId+'/lessons/'+free.lessons[0]+'/progress',{method:'PUT',headers:browser,body})).status,403);
    assert.equal((await fetch(base+'/v1/hubs/'+hubId+'/lessons/'+free.lessons[0]+'/progress',{method:'PUT',headers:{...browser,'x-csrf-token':csrf},body})).status,200);
    const learning=await fetch(base+'/v1/hubs/'+hubId+'/learning',{headers:{authorization:'Bearer learner-a'}});assert.equal(learning.status,200);
    assert.ok(Array.isArray((await learning.json()).products));
    const page=await (await fetch(base+'/h/'+slug+'/learning',{headers:{host,cookie}})).text();assert.ok(page.includes('<h1>My learning</h1>'));
    const lesson=await (await fetch(base+'/h/'+slug+'/lessons/'+paid.lessons[0],{headers:{host,cookie}})).text();
    assert.ok(lesson.includes('id="complete-lesson"'));assert.ok(lesson.includes('data-lesson-id="'+paid.lessons[0]+'"'));assert.ok(lesson.includes('plinth-shell.js'));
    const done=await (await fetch(base+'/h/'+slug+'/lessons/'+paid.lessons[1],{headers:{host,cookie}})).text();assert.ok(done.includes('<p class="done">Completed.</p>'));
    const anonymous=await (await fetch(base+'/h/'+slug+'/lessons/'+free.lessons[0])).text();assert.ok(!anonymous.includes('plinth-shell.js'));assert.ok(!anonymous.includes('data-csrf'));
  });
  const opensOf=async(user,lessonId)=>(await admin.query('SELECT id,user_agent FROM content.lesson_opens WHERE user_id=$1 AND lesson_id=$2 ORDER BY id',[user,lessonId])).rows;
  await check('opening lesson content is logged; only admins read the log and nobody can rewrite it',async()=>{
    const core=paid.lessons[1],before=(await opensOf(buyer,core)).length;
    await opener(buyer).open({hubId,userId:buyer,lessonId:core,device:'TestAgent/1.0 '+'x'.repeat(400)});
    const logged=await opensOf(buyer,core);assert.equal(logged.length,before+1);assert.equal(logged.at(-1).user_agent.length,300);
    assert.ok(logged.at(-1).user_agent.startsWith('TestAgent/1.0'));
    const teaser=(await opensOf(member,paid.lessons[0])).length;await open(member,paid.lessons[0]);assert.equal((await opensOf(member,paid.lessons[0])).length,teaser);
    await open(null,free.lessons[0]);assert.equal((await admin.query('SELECT count(*)::int AS n FROM content.lesson_opens WHERE lesson_id=$1 AND user_id IS NULL',[free.lessons[0]])).rows[0].n,0);
    for(const user of [member,buyer])assert.equal((await db.withSnapshot({hubId,userId:user,orgIds:[],isStaff:false},tx=>tx.query('SELECT * FROM content.lesson_opens'))).rows.length,0);
    const listed=await owner.opens(hubId,paid.id);assert.ok(listed.opens.some(o=>o.user_id===buyer&&o.lesson_id===core));
    await assert.rejects(new CatalogueRepository(db,member).opens(hubId,paid.id),{status:404});
    const as=user=>sql=>db.withSnapshot({hubId,userId:user,orgIds:[],isStaff:false},tx=>tx.query(sql,[hubId,buyer,core]));
    await assert.rejects(as(userA)("UPDATE content.lesson_opens SET user_agent='forged' WHERE hub_id=$1 AND user_id=$2 AND lesson_id=$3"),{code:'42501'});
    await assert.rejects(as(userA)('DELETE FROM content.lesson_opens WHERE hub_id=$1 AND user_id=$2 AND lesson_id=$3'),{code:'42501'});
    await assert.rejects(as(member)('INSERT INTO content.lesson_opens(hub_id,user_id,lesson_id,boundary_id) SELECT $1,$2,id,boundary_id FROM catalogue.lessons WHERE id=$3'),{code:'42501'});
    const c=await admin.connect();
    try{await c.query('BEGIN');await c.query('DROP POLICY company_scope ON content.lesson_opens');await assert.rejects(auditPolicies(c),/Unsafe tenant policies/);}
    finally{await c.query('ROLLBACK');c.release();}
  });
  await check('retention runs only through the maintenance login, counts first and spares recent records',async()=>{
    const records=new MaintenanceRepository(maintenance);
    await assert.rejects(app.query('SELECT app.expire_lesson_opens(30,true)'),{code:'42501'});
    for(const table of ['content.lesson_opens','content.progress_requests'])await assert.rejects(maintenance.query('SELECT * FROM '+table),{code:'42501'});
    if(!embeddedMode)await assert.rejects(maintenance.query('SET ROLE plinth_retention_executor'),{code:'42501'});
    const owner=(await admin.query("SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid='app.expire_lesson_opens(integer,boolean)'::regprocedure")).rows[0].owner;
    assert.equal(owner,'plinth_retention_executor');
    const [oldOpen,recentOpen]=(await opensOf(buyer,paid.lessons[1])).slice(-2);
    await admin.query("UPDATE content.lesson_opens SET opened_at=now()-interval '40 days' WHERE hub_id=$1 AND id=$2",[hubId,oldOpen.id]);
    assert.ok(await records.expireLessonOpens(30)>=1);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM content.lesson_opens WHERE hub_id=$1 AND id=$2',[hubId,oldOpen.id])).rows[0].n,1);
    await records.expireLessonOpens(30,true);
    const remaining=(await admin.query('SELECT id FROM content.lesson_opens WHERE hub_id=$1 AND id=ANY($2::bigint[])',[hubId,[oldOpen.id,recentOpen.id]])).rows.map(r=>String(r.id));
    assert.deepEqual(remaining,[String(recentOpen.id)]);
    const key=(await admin.query('SELECT idempotency_key FROM content.progress_requests WHERE hub_id=$1 AND user_id=$2 LIMIT 1',[hubId,buyer])).rows[0].idempotency_key;
    await admin.query("UPDATE content.progress_requests SET created_at=now()-interval '10 days' WHERE hub_id=$1 AND user_id=$2 AND idempotency_key=$3",[hubId,buyer,key]);
    await records.expireProgressRequests(168,true);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM content.progress_requests WHERE hub_id=$1 AND idempotency_key=$2',[hubId,key])).rows[0].n,0);
    assert.ok((await admin.query('SELECT count(*)::int AS n FROM content.progress_requests WHERE hub_id=$1',[hubId])).rows[0].n>0);
    for(const call of [()=>records.expireLessonOpens(0),()=>records.expireLessonOpens(4000),()=>records.expireProgressRequests(1)])await assert.rejects(call(),{status:400});
  });
  await check('the lesson-open log is admin-only over HTTP and shown in the product editor',async()=>{
    const route=base+'/v1/hubs/'+hubId+'/catalogue/products/'+paid.id+'/opens';
    const listed=await fetch(route+'?limit=1',{headers:{authorization:'Bearer learner-a'}});assert.equal(listed.status,200);
    const page=await listed.json();assert.equal(page.opens.length,1);assert.ok(page.next);
    assert.equal((await fetch(route+'?before='+page.next,{headers:{authorization:'Bearer learner-a'}})).status,200);
    assert.equal((await fetch(route,{headers:{authorization:'Bearer learner-b'}})).status,404);
    assert.equal((await fetch(route+'?limit=0',{headers:{authorization:'Bearer learner-a'}})).status,400);
    const host='learn-new.example',exchange=await fetch(base+'/v1/hubs/'+hubId+'/session',{method:'POST',headers:{authorization:'Bearer learner-a',host,origin:'https://'+host}});
    const editor=await (await fetch(base+'/h/'+slug+'/admin/products/'+paid.id,{headers:{host,cookie:exchange.headers.get('set-cookie').split(';')[0]}})).text();
    assert.ok(editor.includes('Recent lesson opens'));assert.ok(editor.includes('TestAgent/1.0'));
  });
}
