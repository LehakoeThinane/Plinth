import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MessagingRepository } from '../src/db/messaging-repository.js';
import { auditPolicies } from '../src/db/policy-audit.js';
export async function enquiryChecks({admin,db,hubId,userA,companyOrg,check,base,fetch,slug,testUsers}) {
  const messaging=user=>new MessagingRepository(db,user),provider=messaging(userA);
  const as=user=>(sql,params)=>db.withSnapshot({hubId,userId:user,orgIds:[],isStaff:false},tx=>tx.query(sql,params));
  const [prospect,member,suspended,employee,facilitator]=Array.from({length:5},()=>randomUUID());
  testUsers.push(prospect,member,suspended,employee,facilitator);
  await admin.query('INSERT INTO identity.users(id) SELECT unnest($1::uuid[])',[[prospect,member,suspended,employee,facilitator]]);
  await admin.query("INSERT INTO tenancy.memberships(hub_id,user_id,role,status) VALUES($1,$2,'member','active'),($1,$3,'member','suspended'),($1,$4,'member','active'),($1,$5,'facilitator','active')",[hubId,member,suspended,employee,facilitator]);
  await admin.query("INSERT INTO identity.org_members(user_id,org_id,status) VALUES($1,$2,'active')",[employee,companyOrg]);
  const enquiry={subject:'Leadership <b>programme</b>',need:'We need a programme for 40 managers.'};
  let first,second;
  await check('anyone signed in can enquire; only the requester and hub owners/admins can read it',async()=>{
    first=await messaging(prospect).createEnquiry(hubId,enquiry);
    second=await messaging(member).createEnquiry(hubId,{subject:'Coaching',need:'One-on-one coaching?'});
    assert.ok((await messaging(employee).createEnquiry(hubId,{...enquiry,requesterOrg:companyOrg})).id);
    await assert.rejects(messaging(member).createEnquiry(hubId,{...enquiry,requesterOrg:companyOrg}),{status:400});
    await assert.rejects(messaging(suspended).createEnquiry(hubId,enquiry),{status:404});
    await assert.rejects(messaging(null).createEnquiry(hubId,enquiry),{status:401});
    for(const input of [{subject:'',need:'x'},{subject:'x',need:''},{subject:'x',need:'x'.repeat(5001)}])await assert.rejects(messaging(prospect).createEnquiry(hubId,input),{status:400});
    const own=await messaging(prospect).enquiries(hubId);assert.deepEqual([own.provider,own.enquiries.map(q=>q.id)],[false,[first.id]]);
    const inbox=await provider.enquiries(hubId);assert.equal(inbox.provider,true);
    assert.ok([first.id,second.id].every(id=>inbox.enquiries.find(q=>q.id===id)?.unread===1));
    const staff=await messaging(facilitator).enquiries(hubId);assert.deepEqual([staff.provider,staff.enquiries.length],[false,0]);
    for(const user of [member,facilitator])await assert.rejects(messaging(user).enquiry(hubId,first.id),{status:404});
    await assert.rejects(messaging(member).history(hubId,first.conversationId),{status:404});
    assert.equal((await as(member)('SELECT * FROM messaging.messages WHERE conversation_id=$1',[first.conversationId])).rows.length,0);
  });
  await check('nobody can join or claim someone else\'s conversation, even with its id',async()=>{
    await assert.rejects(as(member)("INSERT INTO messaging.participants(hub_id,conversation_id,user_id,role) VALUES($1,$2,$3,'requester')",[hubId,first.conversationId,member]),{code:'42501'});
    await assert.rejects(as(member)("INSERT INTO messaging.participants(hub_id,conversation_id,user_id,role) VALUES($1,$2,$3,'provider')",[hubId,first.conversationId,member]),{code:'42501'});
    await assert.rejects(as(member)("INSERT INTO messaging.enquiries(hub_id,id,conversation_id,requester_id,subject) VALUES($1,$2,$3,$4,'Hijack')",[hubId,randomUUID(),first.conversationId,member]),{code:'42501'});
    await assert.rejects(as(member)("INSERT INTO messaging.messages(hub_id,id,conversation_id,sender_id,client_id,body) VALUES($1,$2,$3,$4,$5,'Injected')",[hubId,randomUUID(),first.conversationId,member,randomUUID()]),{code:'42501'});
    await assert.rejects(as(prospect)("UPDATE messaging.enquiries SET status='closed' WHERE id=$1",[first.id]).then(r=>{if(r.rowCount)throw Object.assign(new Error('changed'),{code:'changed'});throw Object.assign(new Error('blocked'),{code:'blocked'});}),{code:'blocked'});
    const c=await admin.connect();
    try{await c.query('BEGIN');await c.query('DROP POLICY hub_scope ON messaging.messages');await assert.rejects(auditPolicies(c),/Unsafe tenant policies/);}
    finally{await c.query('ROLLBACK');c.release();}
  });
  await check('messages are idempotent by client id, track unread and stop when the enquiry closes',async()=>{
    const clientId=randomUUID(),reply={body:'Happy to help. When would you like to start?',clientId};
    const sent=await provider.send(hubId,first.conversationId,reply);assert.deepEqual(await provider.send(hubId,first.conversationId,reply),sent);
    assert.equal((await provider.history(hubId,first.conversationId)).messages.length,2);
    assert.equal((await provider.enquiry(hubId,first.id)).enquiry.status,'in_discussion');
    assert.equal((await messaging(prospect).enquiries(hubId)).enquiries[0].unread,1);
    await messaging(prospect).markRead(hubId,first.conversationId);assert.equal((await messaging(prospect).enquiries(hubId)).enquiries[0].unread,0);
    await messaging(prospect).send(hubId,first.conversationId,{body:'Next month.',clientId:randomUUID()});
    const latest=await messaging(prospect).history(hubId,first.conversationId,{limit:1});
    assert.deepEqual([latest.messages.map(m=>m.body),Boolean(latest.older)],[['Next month.'],true]);
    const earlier=await messaging(prospect).history(hubId,first.conversationId,{before:latest.older,limit:5});
    assert.deepEqual(earlier.messages.map(m=>m.sender_role),['requester','provider']);
    await assert.rejects(messaging(member).send(hubId,first.conversationId,{body:'Intruding',clientId:randomUUID()}),{status:404});
    await assert.rejects(messaging(prospect).setStatus(hubId,first.id,'closed'),{status:404});
    await provider.setStatus(hubId,first.id,'closed');
    for(const user of [prospect,userA])await assert.rejects(messaging(user).send(hubId,first.conversationId,{body:'Late',clientId:randomUUID()}),{status:409});
    assert.equal((await messaging(prospect).enquiry(hubId,first.id)).messages.length,3);
    for(const bad of [{body:'',clientId:randomUUID()},{body:'x'},{body:'x',clientId:'not-a-uuid'}])await assert.rejects(provider.send(hubId,second.conversationId,bad),{status:400});
  });
  await check('enquiry HTTP routes and pages: prospects enquire, providers reply, others are refused',async()=>{
    const api=path=>base+'/v1/hubs/'+hubId+'/'+path,provHeaders={authorization:'Bearer learner-a'};
    const created=await fetch(api('enquiries'),{method:'POST',headers:{authorization:'Bearer learner-b'},body:JSON.stringify({subject:'Via API',need:'Keynote for 200 people'})});
    assert.equal(created.status,201);const {id,conversationId}=await created.json();
    assert.equal((await fetch(api('enquiries'),{method:'POST',body:JSON.stringify(enquiry)})).status,401);
    const clientId=randomUUID(),body=JSON.stringify({body:'Thanks, let us talk.',clientId});
    const one=await (await fetch(api('conversations/'+conversationId+'/messages'),{method:'POST',headers:provHeaders,body})).json();
    const two=await (await fetch(api('conversations/'+conversationId+'/messages'),{method:'POST',headers:provHeaders,body})).json();assert.equal(one.id,two.id);
    assert.equal((await fetch(api('conversations/'+conversationId+'/read'),{method:'PUT',headers:provHeaders})).status,200);
    assert.equal((await fetch(api('enquiries/'+id),{method:'PATCH',headers:{authorization:'Bearer learner-b'},body:JSON.stringify({status:'closed'})})).status,404);
    assert.equal((await fetch(api('enquiries/'+id),{method:'PATCH',headers:provHeaders,body:JSON.stringify({status:'closed'})})).status,200);
    assert.equal((await (await fetch(api('enquiries'),{headers:provHeaders})).json()).provider,true);
    const host='learn-new.example',exchange=await fetch(base+'/v1/hubs/'+hubId+'/session',{method:'POST',headers:{...provHeaders,host,origin:'https://'+host}});
    const cookie=exchange.headers.get('set-cookie').split(';')[0],csrf=(await exchange.json()).csrfToken,browser={host,origin:'https://'+host,cookie};
    assert.equal((await fetch(api('conversations/'+second.conversationId+'/messages'),{method:'POST',headers:browser,body:JSON.stringify({body:'No CSRF',clientId:randomUUID()})})).status,403);
    assert.equal((await fetch(api('conversations/'+second.conversationId+'/messages'),{method:'POST',headers:{...browser,'x-csrf-token':csrf},body:JSON.stringify({body:'With CSRF',clientId:randomUUID()})})).status,201);
    const inbox=await (await fetch(base+'/h/'+slug+'/enquiries',{headers:{host,cookie}})).text();
    assert.ok(inbox.includes('Enquiries inbox'));assert.ok(inbox.includes('Leadership &lt;b&gt;programme&lt;/b&gt;'));assert.ok(!inbox.includes('<b>programme'));
    const thread=await (await fetch(base+'/h/'+slug+'/enquiries/'+second.id,{headers:{host,cookie}})).text();
    assert.ok(thread.includes('id="send-message"'));assert.ok(thread.includes('id="enquiry-status"'));assert.ok(thread.includes('With CSRF'));
    const anonymous=await fetch(base+'/h/'+slug+'/enquiries',{headers:{host}});
    assert.equal(anonymous.status,303);assert.equal(anonymous.headers.get('location'),'/h/'+slug+'/sign-in?view=enquiries');
    assert.ok((await (await fetch(base+'/h/'+slug)).text()).includes('Enquire about bespoke work'));
  });
}
