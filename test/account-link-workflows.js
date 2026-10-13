import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { auditPolicies } from '../src/db/policy-audit.js';
const digest=cookie=>createHash('sha256').update(cookie.split('=')[1]).digest('hex');
export async function accountLinkChecks({admin,app,auth,db,a,b,userA,userB,issuer,authRepository,provider,base,fetch,check}) {
  const slug='test-'+a,host={host:'learn-a.example',origin:'https://learn-a.example'};
  const linked=subject=>admin.query('SELECT user_id FROM identity.auth_links WHERE issuer=$1 AND subject=$2',[issuer,subject]).then(r=>r.rows[0]?.user_id);
  async function browserSession(hubId=a,headers=host) {
    const response=await fetch(base+'/v1/hubs/'+hubId+'/session',{method:'POST',headers:{...headers,authorization:'Bearer learner-a'}});
    assert.equal(response.status,201);
    const cookie=response.headers.get('set-cookie').split(';')[0];
    return {cookie,hash:digest(cookie),csrf:(await response.json()).csrfToken};
  }
  const age=(session,minutes)=>admin.query("UPDATE identity.auth_sessions SET created_at=now()-make_interval(mins=>$2) WHERE token_hash=$1",[session.hash,minutes]);
  const links=base+'/v1/hubs/'+a+'/account/links';
  const mutate=(session,method,body,{csrf=true}={})=>fetch(links,{method,
    headers:{...host,cookie:session.cookie,...(csrf?{'x-csrf-token':session.csrf}:{})},body:JSON.stringify(body)});
  async function link(session,subject) {
    const started=await mutate(session,'POST',{slug});assert.equal(started.status,200);
    const location=(await started.json()).location,login=started.headers.get('set-cookie').split(';')[0];
    assert.equal(new URL(location).searchParams.get('prompt'),'login');
    const callback=provider.authorize(location,{overrides:{sub:subject}});
    return fetch(base+callback.pathname+callback.search,{headers:{host:'learn-a.example',cookie:session.cookie+'; '+login}});
  }
  const session=await browserSession();
  await check('sign-in method functions are executor-owned and runtime roles cannot change links or history',async()=>{
    for(const signature of ['app.read_auth_session(text)','app.link_auth_identity(text,text,text,uuid)','app.unlink_auth_identity(text,text,text,uuid)'])
      assert.equal((await admin.query('SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid=$1::regprocedure',[signature])).rows[0].owner,'plinth_auth_executor');
    await assert.rejects(app.query('SELECT app.link_auth_identity($1,$2,$3,$4)',[session.hash,issuer,'forged',userA]),{code:'42501'});
    await assert.rejects(app.query('SELECT app.unlink_auth_identity($1,$2,$3,$4)',[session.hash,issuer,'subject-a',userA]),{code:'42501'});
    await assert.rejects(auth.query('SELECT * FROM identity.account_events'),{code:'42501'});
    await assert.rejects(db.withSnapshot({hubId:a,userId:userA,orgIds:[],isStaff:false},tx=>tx.query("INSERT INTO identity.account_events(id,user_id,action,issuer,subject) VALUES($1,$2,'linked',$3,'forged')",[b,userA,issuer])),{code:'42501'});
    await assert.rejects(db.withSnapshot({hubId:a,userId:userA,orgIds:[],isStaff:false},tx=>tx.query('DELETE FROM identity.auth_links')),{code:'42501'});
    const c=await admin.connect();
    try{await c.query('BEGIN');await c.query('DROP POLICY self_scope ON identity.account_events');await assert.rejects(auditPolicies(c),/Unsafe identity policies/);}
    finally{await c.query('ROLLBACK');c.release();}
  });
  await check('starting a link requires a recent browser session, CSRF and the session hub',async()=>{
    const bearer=await fetch(links,{method:'POST',headers:{authorization:'Bearer learner-a'},body:JSON.stringify({slug})});
    assert.equal(bearer.status,403);assert.equal((await bearer.json()).error,'browser_session_required');
    assert.equal((await mutate(session,'POST',{slug},{csrf:false})).status,403);
    assert.equal((await mutate(session,'POST',{slug:'test-'+b})).status,404);
    await age(session,11);
    try {
      const stale=await mutate(session,'POST',{slug});assert.equal(stale.status,403);assert.equal((await stale.json()).error,'reauthentication_required');
      const page=await fetch(base+'/h/'+slug+'/account',{headers:{host:'learn-a.example',cookie:session.cookie}});
      assert.match(await page.text(),/Sign in again/);
    }finally{await age(session,0);}
  });
  const added='subject-link-'+a;
  await check('linking attaches the re-authenticated identity to the session account without provisioning',async()=>{
    const users=(await admin.query('SELECT count(*)::int AS n FROM identity.users')).rows[0].n;
    const response=await link(session,added);
    assert.equal(response.status,303);assert.equal(response.headers.get('location'),'/h/'+slug+'/account?link=linked');
    assert.doesNotMatch(response.headers.get('set-cookie'),/__Host-plinth-session=[0-9a-f]/);
    assert.equal(await linked(added),userA);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM identity.users')).rows[0].n,users);
    assert.equal(await authRepository.resolveUser(issuer,added),userA);
    const events=(await admin.query("SELECT action FROM identity.account_events WHERE user_id=$1 AND subject=$2",[userA,added])).rows;
    assert.deepEqual(events.map(e=>e.action),['linked']);
    assert.equal((await (await link(session,added)).headers.get('location')),'/h/'+slug+'/account?link=unchanged');
    const listing=await (await fetch(links,{headers:{authorization:'Bearer learner-a'}})).json();
    assert.deepEqual(listing.methods.map(m=>m.subject).sort(),[added,'subject-a'].sort());
    const page=await fetch(base+'/h/'+slug+'/account?link=linked',{headers:{host:'learn-a.example',cookie:session.cookie}});
    assert.equal(page.status,200);const html=await page.text();
    assert.match(html,/now linked to this account/);assert.ok(html.includes(added));assert.match(html,/id="link-method">/);
  });
  await check('an identity owned by another account is refused and stays with its owner',async()=>{
    await admin.query('INSERT INTO identity.auth_links(issuer,subject,user_id) VALUES($1,$2,$3)',[issuer,'subject-owned-'+b,userB]);
    const response=await link(session,'subject-owned-'+b);
    assert.equal(response.headers.get('location'),'/h/'+slug+'/account?link=conflict');
    assert.equal(await linked('subject-owned-'+b),userB);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM identity.account_events WHERE subject=$1',['subject-owned-'+b])).rows[0].n,0);
  });
  await check('a link callback without its live, recent starting session does not link',async()=>{
    const started=await mutate(session,'POST',{slug}),location=(await started.json()).location,login=started.headers.get('set-cookie').split(';')[0];
    const callback=provider.authorize(location,{overrides:{sub:'subject-late-'+a}}),route=base+callback.pathname+callback.search;
    await age(session,21);
    try{assert.equal((await fetch(route,{headers:{host:'learn-a.example',cookie:session.cookie+'; '+login}})).status,401);}
    finally{await age(session,0);}
    const again=await mutate(session,'POST',{slug}),retry=provider.authorize((await again.json()).location,{overrides:{sub:'subject-late-'+a}});
    assert.equal((await fetch(base+retry.pathname+retry.search,{headers:{host:'learn-a.example',cookie:again.headers.get('set-cookie').split(';')[0]}})).status,401);
    assert.equal(await linked('subject-late-'+a),undefined);
  });
  await check('removing a method needs a recent session, keeps the last method and ends other sessions',async()=>{
    const other=await browserSession(b,{host:'learn-b.example',origin:'https://learn-b.example'});
    const otherLinks=()=>fetch(base+'/v1/hubs/'+b+'/account/links',{headers:{host:'learn-b.example',cookie:other.cookie}});
    assert.equal((await otherLinks()).status,200);
    assert.equal((await mutate(session,'DELETE',{issuer,subject:added},{csrf:false})).status,403);
    assert.equal((await fetch(links,{method:'DELETE',headers:{authorization:'Bearer learner-a'},body:JSON.stringify({issuer,subject:added})})).status,403);
    assert.equal((await mutate(session,'DELETE',{issuer})).status,400);
    await age(session,11);
    try{const stale=await mutate(session,'DELETE',{issuer,subject:added});assert.equal(stale.status,403);assert.equal((await stale.json()).error,'reauthentication_required');}
    finally{await age(session,0);}
    assert.equal((await mutate(session,'DELETE',{issuer,subject:'subject-owned-'+b})).status,404);
    assert.equal(await linked('subject-owned-'+b),userB);
    assert.equal((await mutate(session,'DELETE',{issuer,subject:added})).status,200);
    assert.equal(await linked(added),undefined);assert.equal((await otherLinks()).status,401);
    const remaining=await fetch(links,{headers:{...host,cookie:session.cookie}});assert.equal(remaining.status,200);
    assert.deepEqual((await remaining.json()).methods.map(m=>m.subject),['subject-a']);
    assert.equal((await mutate(session,'DELETE',{issuer,subject:'subject-a'})).status,409);
    const history=(await admin.query('SELECT action FROM identity.account_events WHERE user_id=$1 AND subject=$2 ORDER BY created_at',[userA,added])).rows;
    assert.deepEqual(history.map(e=>e.action),['linked','unlinked']);
  });
  await check('concurrent removals cannot remove every sign-in method',async()=>{
    assert.equal(await authRepository.linkIdentity(session.hash,issuer,'subject-c-'+a),'linked');
    const results=await Promise.allSettled([authRepository.unlinkIdentity(session.hash,{issuer,subject:'subject-a'}),
      authRepository.unlinkIdentity(session.hash,{issuer,subject:'subject-c-'+a})]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM identity.auth_links WHERE user_id=$1',[userA])).rows[0].n,1);
    // Restore the original method for later checks.
    if(await linked('subject-a')!==userA) {
      assert.equal(await authRepository.linkIdentity(session.hash,issuer,'subject-a'),'linked');
      await authRepository.unlinkIdentity(session.hash,{issuer,subject:'subject-c-'+a});
    }
  });
}
