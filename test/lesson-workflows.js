import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CatalogueRepository } from '../src/db/catalogue-repository.js';
import { PostgresAccessRepository } from '../src/db/access-repository.js';
import { AccessService } from '../src/access.js';
import { MemoryAccessCache } from '../src/cache/memory.js';
import { auditPolicies } from '../src/db/policy-audit.js';
export async function lessonChecks({admin,db,hubId,userA,userB,companyOrg,check,base,fetch,slug,testUsers}) {
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
}
