import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { LibraryRepository } from '../src/db/library-repository.js';
import { CatalogueRepository } from '../src/db/catalogue-repository.js';
import { PostgresAccessRepository } from '../src/db/access-repository.js';
import { AccessService } from '../src/access.js';
import { MemoryAccessCache } from '../src/cache/memory.js';
export async function libraryChecks({admin,db,hubId,userA,companyOrg,check,base,fetch,slug,testUsers}) {
  const owner=new LibraryRepository(db,userA),catalogue=new CatalogueRepository(db,userA),cache=new MemoryAccessCache();
  const open=(user,itemId)=>new AccessService(new PostgresAccessRepository(db,user),cache).openLibraryItem({hubId,userId:user,itemId});
  const member=randomUUID(),buyer=randomUUID(),tierHolder=randomUUID(),outsider=randomUUID(),tier=randomUUID();
  testUsers.push(member,buyer,tierHolder,outsider);
  await admin.query('INSERT INTO identity.users(id) VALUES($1),($2),($3),($4)',[member,buyer,tierHolder,outsider]);
  await admin.query("INSERT INTO tenancy.memberships(hub_id,user_id,role,status) VALUES($1,$2,'member','active'),($1,$3,'member','active'),($1,$4,'member','active')",[hubId,member,buyer,tierHolder]);
  async function paidProduct(title,visibility='public') {
    const product=await catalogue.create(hubId,{type:'course',title,visibility,accessMode:'entitled',...(visibility==='company'?{companyOrg}:{})});
    const module=await catalogue.addModule(hubId,product.id,{title:'Module'});
    await catalogue.addLesson(hubId,product.id,{moduleId:module.id,title:'Lesson'});
    if(visibility!=='company')await catalogue.addPlan(hubId,product.id,{model:'once_off',amountCents:30000});
    return product.id;
  }
  const article=(title,extra={})=>({title,summary:title+' summary',body:title+' body <i>text</i>',topics:['leadership'],...extra});
  let shelfProduct,companyProduct,items={};
  await check('library authoring is admin-only and refuses company products and malformed topics',async()=>{
    shelfProduct=await paidProduct('Library course');companyProduct=await paidProduct('Private programme','company');
    const free=(await catalogue.create(hubId,{type:'course',title:'Free',visibility:'public',accessMode:'open'})).id;
    for(const repository of [new LibraryRepository(db,member),new LibraryRepository(db)])await assert.rejects(repository.create(hubId,article('Forged',{visibility:'public'})),{status:404});
    for(const input of [{visibility:'entitled'},{visibility:'entitled',requiredProductId:companyProduct},{visibility:'entitled',requiredProductId:free},
      {visibility:'public',topics:['Bad Topic']},{visibility:'public',topics:['a','b','c','d','e','f']},{visibility:'secret'}])
      await assert.rejects(owner.create(hubId,article('Invalid',input)),{status:400});
    await assert.rejects(db.withSnapshot({hubId,userId:member,orgIds:[],isStaff:true},tx=>tx.query("INSERT INTO library.items(hub_id,id,title,visibility) VALUES($1,$2,'Forged','public')",[hubId,randomUUID()])),{code:'42501'});
    for(const [key,input] of [['public',{visibility:'public',topics:['leadership','voice']}],['members',{visibility:'members'}],['tier',{visibility:'tier',topics:['voice']}],['entitled',{visibility:'entitled',requiredProductId:shelfProduct}]])
      items[key]=(await owner.create(hubId,article(key+' <b>item</b>',input))).id;
    await assert.rejects(admin.query('UPDATE library.items SET required_product_id=$2 WHERE id=$1',[items.entitled,companyProduct]),{code:'23514'});
    assert.ok(!(await new LibraryRepository(db).browse(hubId)).items.some(i=>i.id===items.public));
    for(const id of Object.values(items))await owner.setStatus(hubId,id,'published');
    await assert.rejects(owner.setStatus(hubId,items.public,'published'),{status:409});
    await assert.rejects(admin.query("UPDATE library.items SET status='draft' WHERE id=$1",[items.public]),{code:'23514'});
  });
  await check('library items open by visibility through the shared access decision',async()=>{
    await admin.query("INSERT INTO access.entitlements(hub_id,id,user_id,target_id,kind) VALUES($1,$2,$3,$4,'tier'),($1,$5,$6,$7,'product')",[hubId,randomUUID(),tierHolder,tier,randomUUID(),buyer,shelfProduct]);
    await admin.query('INSERT INTO access.tier_benefits(hub_id,tier_id,target_id) VALUES($1,$2,$3)',[hubId,tier,items.tier]);
    const outcome=async(user,key)=>{const r=await open(user,items[key]);return r.decision==='locked'?'locked:'+r.reason:r.decision;};
    const allowed=await open(null,items.public);assert.equal(allowed.decision,'allowed');assert.ok(allowed.item.body.startsWith('public'));
    // Entitled items stay closed until their product is published.
    assert.equal(await outcome(buyer,'entitled'),'not_found');
    assert.ok(!(await new LibraryRepository(db).browse(hubId)).items.some(i=>i.id===items.entitled));
    await catalogue.publish(hubId,shelfProduct);
    const expected={members:{[member]:'allowed',[outsider]:'locked:join',null:'locked:join'},tier:{[member]:'locked:tier',[tierHolder]:'allowed'},
      entitled:{[member]:'locked:purchase',[buyer]:'allowed',[tierHolder]:'locked:purchase'}};
    for(const [key,cases] of Object.entries(expected))for(const [user,result] of Object.entries(cases))
      assert.equal(await outcome(user==='null'?null:user,key),result,key+' for '+user);
    const locked=await open(member,items.entitled);assert.equal('body' in locked.item,false);assert.equal(locked.item.requiredProductId,shelfProduct);
    assert.equal(await outcome(userA,'tier'),'allowed');
    await admin.query("UPDATE tenancy.memberships SET status='suspended' WHERE hub_id=$1 AND user_id=$2",[hubId,member]);
    try{assert.equal(await outcome(member,'members'),'not_found');}
    finally{await admin.query("UPDATE tenancy.memberships SET status='active' WHERE hub_id=$1 AND user_id=$2",[hubId,member]);}
    const archived=(await owner.create(hubId,article('Archived',{visibility:'public'}))).id;
    await owner.setStatus(hubId,archived,'published');await owner.setStatus(hubId,archived,'archived');
    assert.equal((await open(member,archived)).decision,'not_found');assert.equal((await open(userA,archived)).decision,'allowed');
  });
  await check('browsing lists published previews newest first, filters by topic and pages without repeats',async()=>{
    const reader=new LibraryRepository(db),all=(await reader.browse(hubId,{limit:100})).items;
    assert.ok(all.every(i=>!('body' in i)));
    for(let i=1;i<all.length;i++)assert.ok(new Date(all[i-1].published_at)>=new Date(all[i].published_at));
    const seen=[];let before=null;
    do{const page=await reader.browse(hubId,{before,limit:1});seen.push(...page.items.map(i=>i.id));before=page.next;}while(before);
    assert.deepEqual(seen,all.map(i=>i.id));
    assert.deepEqual((await reader.browse(hubId,{topic:'voice'})).items.map(i=>i.id).sort(),[items.public,items.tier].sort());
    for(const options of [{topic:'Not Valid'},{limit:0},{before:'garbage'}])await assert.rejects(reader.browse(hubId,options),{status:400});
  });
  await check('library HTTP routes: public browse, optional identity, admin-only authoring and escaped pages',async()=>{
    const list=await fetch(base+'/v1/hubs/'+hubId+'/library?topic=leadership');assert.equal(list.status,200);assert.ok((await list.json()).items.length>0);
    const item=id=>base+'/v1/hubs/'+hubId+'/library/'+id;
    assert.equal((await (await fetch(item(items.public))).json()).decision,'allowed');
    const locked=await (await fetch(item(items.members))).json();assert.deepEqual([locked.decision,locked.reason,locked.item.body],['locked','join',undefined]);
    assert.equal((await fetch(item(items.public),{headers:{authorization:'Bearer invalid'}})).status,401);
    assert.equal((await fetch(item(randomUUID()))).status,404);
    const page=await (await fetch(base+'/h/'+slug+'/library')).text();
    assert.ok(page.includes('public &lt;b&gt;item&lt;/b&gt;'),'escaped title');
    assert.ok(!page.includes('<b>item'),'no raw markup');
    assert.ok(page.includes('?topic=voice'),'topic link');
    const lockedPage=await (await fetch(base+'/h/'+slug+'/library/'+items.entitled)).text();assert.ok(lockedPage.includes('Join the hub'),'signed-out visitors must join before buying');assert.ok(!lockedPage.includes('entitled <b>item</b> body'));
    const readable=await (await fetch(base+'/h/'+slug+'/library/'+items.public)).text();assert.ok(readable.includes('<p>public &lt;b&gt;item&lt;/b&gt; body &lt;i&gt;text&lt;/i&gt;</p>'));
    const route=base+'/v1/hubs/'+hubId+'/catalogue/library';
    assert.equal((await fetch(route,{method:'POST',headers:{authorization:'Bearer learner-b'},body:JSON.stringify(article('X',{visibility:'public'}))})).status,404);
    const created=await fetch(route,{method:'POST',headers:{authorization:'Bearer learner-a'},body:JSON.stringify(article('HTTP article',{visibility:'members'}))});
    assert.equal(created.status,201);const id=(await created.json()).id;
    assert.equal((await fetch(route+'/'+id,{method:'PATCH',headers:{authorization:'Bearer learner-a'},body:JSON.stringify({visibility:'public',topics:['voice']})})).status,200);
    assert.equal((await fetch(route+'/'+id+'/publish',{method:'POST',headers:{authorization:'Bearer learner-a'}})).status,200);
    assert.equal((await (await fetch(item(id))).json()).decision,'allowed');
    const host='learn-new.example',exchange=await fetch(base+'/v1/hubs/'+hubId+'/session',{method:'POST',headers:{authorization:'Bearer learner-a',host,origin:'https://'+host}});
    const cookie=exchange.headers.get('set-cookie').split(';')[0];
    const adminList=await fetch(base+'/h/'+slug+'/admin/library',{headers:{host,cookie}});assert.equal(adminList.status,200);assert.ok((await adminList.text()).includes('id="create-library-item"'));
    const editor=await (await fetch(base+'/h/'+slug+'/admin/library/'+items.entitled,{headers:{host,cookie}})).text();
    assert.ok(editor.includes('id="library-item"'));assert.ok(editor.includes('>Library course</option>'));assert.ok(!editor.includes('>Private programme</option>'));
  });
}
