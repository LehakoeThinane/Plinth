import assert from 'node:assert/strict';
import pg from 'pg';
import { TenantDatabase } from '../src/db/tenant.js';
import { NoticeRepository } from '../src/db/notice-repository.js';
import { ConsentRepository } from '../src/db/consent-repository.js';
import { auditPolicies } from '../src/db/policy-audit.js';
export async function noticeChecks({admin,app,db,hubId,otherHub,userA,userB,check,embeddedMode,base,fetch,slug}) {
  const owner=new NoticeRepository(db,userA),learner=new NoticeRepository(db,userB),consent=new ConsentRepository(db,userA);
  const input={purpose:'research',noticeVersion:'v1',noticeText:'Original research notice',expectedVersion:null};
  await check('active hub owner publishes a notice and an atomic publication snapshot',async()=>{
    await owner.publish(hubId,input);const history=(await owner.history(hubId)).publications;
    assert.equal(history[0].kind,'published');assert.equal(history[0].actor,userA);assert.equal(history[0].notice_text,input.noticeText);
    assert.equal((await consent.list(hubId)).find(n=>n.purpose==='research').granted,false);
  });
  await check('notice writes and history reject learners, other hubs and direct privilege escalation',async()=>{
    await assert.rejects(learner.publish(hubId,{...input,purpose:'forged'}),{status:404});await assert.rejects(learner.history(hubId),{status:404});
    await assert.rejects(owner.publish(otherHub,input),{status:404});
    const role=(await admin.query("SELECT rolcanlogin,rolsuper,rolbypassrls FROM pg_roles WHERE rolname='plinth_consent_executor'")).rows[0];assert.deepEqual(role,{rolcanlogin:false,rolsuper:false,rolbypassrls:false});
    assert.equal((await admin.query("SELECT pg_has_role('plinth_app','plinth_consent_executor','MEMBER') AS member")).rows[0].member,false);
    assert.equal((await admin.query("SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid='app.audit_notice_publication()'::regprocedure")).rows[0].owner,'plinth_consent_executor');
    if(!embeddedMode)await assert.rejects(app.query('SET ROLE plinth_consent_executor'),{code:'42501'});
    await assert.rejects(db.withSnapshot({hubId,userId:userB,orgIds:[],isStaff:false},tx=>tx.query("INSERT INTO compliance.consent_purposes(hub_id,purpose,notice_version,notice_text) VALUES($1,'forged','v1','Forged')",[hubId])),{code:'42501'});
  });
  await check('notice revisions cannot reuse a version or alter publication history',async()=>{
    await assert.rejects(owner.publish(hubId,{...input,expectedVersion:'v1'}),{status:400});
    await owner.publish(hubId,{...input,noticeVersion:'v2',noticeText:'Revised research notice',expectedVersion:'v1'});
    await assert.rejects(owner.publish(hubId,{...input,expectedVersion:'v2'}),{status:409});
    await assert.rejects(db.withSnapshot({hubId,userId:userA,orgIds:[],isStaff:false},tx=>tx.query("UPDATE compliance.consent_purposes SET notice_text='Silent edit' WHERE purpose='research'")),{code:'23514'});
    for(const verb of ['DELETE FROM','UPDATE'])await assert.rejects(app.query(verb==='UPDATE'?"UPDATE compliance.notice_publications SET notice_text='Forged'":'DELETE FROM compliance.notice_publications'),{code:'42501'});
    assert.equal((await owner.history(hubId)).publications.length,2);
  });
  let current;
  await check('concurrent publications with the same expected version accept only one revision',async()=>{
    const pool=embeddedMode?null:new pg.Pool({connectionString:process.env.DATABASE_URL,max:2});
    const other=pool?new NoticeRepository(new TenantDatabase(pool),userA):owner;
    try {
      const results=await Promise.allSettled([owner.publish(hubId,{...input,noticeVersion:'v3',expectedVersion:'v2'}),other.publish(hubId,{...input,noticeVersion:'v4',expectedVersion:'v2'})]);
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
      current=results.find(r=>r.status==='fulfilled').value.notice_version;
    }finally{if(pool)await pool.end();}
  });
  await check('publishing invalidates old grants and preserves their exact consent snapshot',async()=>{
    await consent.set(hubId,{purpose:'research',granted:true,noticeVersion:current});
    await owner.publish(hubId,{...input,noticeVersion:'v5',noticeText:'New agreement <script>unsafe</script>',expectedVersion:current});
    assert.equal((await consent.list(hubId)).find(n=>n.purpose==='research').granted,false);
    const event=(await admin.query("SELECT notice_version,notice_text FROM compliance.consent_events WHERE hub_id=$1 AND purpose='research' ORDER BY id DESC LIMIT 1",[hubId])).rows[0];
    assert.equal(event.notice_version,current);assert.equal(event.notice_text,input.noticeText);
    await assert.rejects(consent.set(hubId,{purpose:'research',granted:true,noticeVersion:current}),{status:409});
    await consent.set(hubId,{purpose:'research',granted:true,noticeVersion:'v5'});assert.equal((await consent.list(hubId)).find(n=>n.purpose==='research').granted,true);
  });
  await check('notice publication racing a consent save never records mismatched notice text',async()=>{
    const pool=embeddedMode?null:new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});
    const independent=pool?new ConsentRepository(new TenantDatabase(pool),userA):consent;
    try {
      const results=await Promise.allSettled([owner.publish(hubId,{...input,noticeVersion:'v6',noticeText:'Current research',expectedVersion:'v5'}),independent.set(hubId,{purpose:'research',granted:true,noticeVersion:'v5'})]);
      assert.equal(results[0].status,'fulfilled');if(results[1].status==='rejected')assert.equal(results[1].reason.status,409);
    }finally{if(pool)await pool.end();}
    const mismatches=await admin.query(`SELECT c.id FROM compliance.consent_events c JOIN compliance.notice_publications p
      ON c.hub_id=p.hub_id AND c.purpose=p.purpose AND c.notice_version=p.notice_version
      WHERE c.hub_id=$1 AND c.notice_text<>p.notice_text`,[hubId]);assert.equal(mismatches.rows.length,0);
  });
  await check('policy audit rejects a missing publication-history admin boundary',async()=>{
    for(const statement of ['DROP POLICY admin_scope ON compliance.notice_publications','DROP POLICY admin_insert ON compliance.consent_purposes','DROP POLICY admin_update ON compliance.consent_purposes']) {
      const c=await admin.connect();try{await c.query('BEGIN');await c.query(statement);await assert.rejects(auditPolicies(c),/Unsafe notice publication policies/);}
      finally{await c.query('ROLLBACK');c.release();}
    }
  });
  await check('notice HTTP publishing handles CSRF, large Unicode text, stale versions and escaped admin forms',async()=>{
    const host={host:'learn-new.example',origin:'https://learn-new.example'},auth={authorization:'Bearer learner-a'};
    const exchange=await fetch(base+'/v1/hubs/'+hubId+'/session',{method:'POST',headers:{...host,...auth}});assert.equal(exchange.status,201);
    const cookie=exchange.headers.get('set-cookie').split(';')[0],csrf=(await exchange.json()).csrfToken,headers={...host,cookie},route=base+'/v1/hubs/'+hubId+'/notices';
    const body=JSON.stringify({...input,purpose:'survey',noticeText:'知'.repeat(5000)+'<script>unsafe</script>'});
    assert.equal((await fetch(route,{method:'PUT',headers,body})).status,403);
    assert.equal((await fetch(route,{method:'PUT',headers:{...headers,'x-csrf-token':csrf},body})).status,200);
    assert.equal((await fetch(route,{method:'PUT',headers:{...headers,'x-csrf-token':csrf},body})).status,409);
    assert.equal((await fetch(route,{headers:{authorization:'Bearer learner-b'}})).status,404);
    assert.equal((await fetch(base+'/v1/hubs/'+otherHub+'/notices',{headers})).status,404);
    const page=await fetch(base+'/h/'+slug+'/admin',{headers});assert.equal(page.status,200);const html=await page.text();assert.match(html,/class="publish-notice"/);assert.match(html,/&lt;script&gt;unsafe&lt;\/script&gt;/);assert.ok(!html.includes('<script>unsafe'));
    assert.equal((await fetch(route,{method:'PUT',headers:{...headers,'x-csrf-token':csrf},body:JSON.stringify({...input,purpose:'oversize',noticeText:'x'.repeat(70000)})})).status,413);
  });
  const research=async()=>(await consent.list(hubId)).find(n=>n.purpose==='research');
  const asOwner=sql=>db.withSnapshot({hubId,userId:userA,orgIds:[],isStaff:false},tx=>tx.query(sql));
  await check('retiring a purpose deactivates grants, refuses new grants and still allows withdrawal',async()=>{
    await consent.set(hubId,{purpose:'research',granted:true,noticeVersion:'v6'});assert.equal((await research()).granted,true);
    await assert.rejects(learner.retire(hubId,{purpose:'research',expectedVersion:'v6'}),{status:404});
    await assert.rejects(owner.retire(hubId,{purpose:'research',expectedVersion:'v5'}),{status:409});
    const retired=await owner.retire(hubId,{purpose:'research',expectedVersion:'v6'});assert.ok(retired.retired_at);
    assert.deepEqual({retired:(await research()).retired,granted:(await research()).granted},{retired:true,granted:false});
    await assert.rejects(owner.retire(hubId,{purpose:'research',expectedVersion:'v6'}),{status:409});
    await assert.rejects(consent.set(hubId,{purpose:'research',granted:true,noticeVersion:'v6'}),{status:409});
    await assert.rejects(asOwner("UPDATE compliance.consents SET granted=true WHERE purpose='research'"),{code:'23514'});
    assert.equal((await consent.set(hubId,{purpose:'research',granted:false,noticeVersion:'v6'})).granted,false);
    const row=(await admin.query("SELECT retired_by,notice_version FROM compliance.notice_retirements WHERE hub_id=$1 AND purpose='research'",[hubId])).rows;
    assert.deepEqual(row,[{retired_by:userA,notice_version:'v6'}]);
    // Look the entry up rather than assuming it sorts first: ordering across
    // transactions follows the database clock, which a VM time correction can step.
    const retirement=(await owner.history(hubId,{limit:100})).publications.find(r=>r.kind==='retired'&&r.purpose==='research');
    assert.equal(retirement.notice_version,'v6');assert.equal(retirement.actor,userA);
  });
  await check('retirement history and stamps cannot be forged or undone in place',async()=>{
    await assert.rejects(app.query("INSERT INTO compliance.notice_retirements(hub_id,purpose,notice_version) VALUES($1,'research','forged')",[hubId]),{code:'42501'});
    await assert.rejects(asOwner('DELETE FROM compliance.notice_retirements'),{code:'42501'});
    await assert.rejects(asOwner("UPDATE compliance.consent_purposes SET retired_at=NULL WHERE purpose='research'"),{code:'23514'});
    await assert.rejects(asOwner("UPDATE compliance.consent_purposes SET retired_by=NULL WHERE purpose='research'"),{code:'42501'});
    const c=await admin.connect();
    try{await c.query('BEGIN');await c.query('DROP POLICY admin_scope ON compliance.notice_retirements');await assert.rejects(auditPolicies(c),/Unsafe notice publication policies/);}
    finally{await c.query('ROLLBACK');c.release();}
  });
  await check('republishing a retired purpose needs a new version and never revives old grants',async()=>{
    await assert.rejects(owner.publish(hubId,{...input,noticeVersion:'v6',expectedVersion:'v6'}),{status:400});
    await owner.publish(hubId,{...input,noticeVersion:'v7',noticeText:'Research resumes',expectedVersion:'v6'});
    assert.deepEqual({retired:(await research()).retired,granted:(await research()).granted},{retired:false,granted:false});
    await assert.rejects(owner.publish(hubId,{...input,noticeVersion:'v6',expectedVersion:'v7'}),{status:409});
    await consent.set(hubId,{purpose:'research',granted:true,noticeVersion:'v7'});assert.equal((await research()).granted,true);
  });
  await check('notice history pages through publications and retirements without gaps or repeats',async()=>{
    await admin.query("INSERT INTO compliance.notice_publications(hub_id,purpose,notice_version,notice_text,published_at) VALUES($1,'research','legacy','Imported',NULL)",[hubId]);
    const expected=(await admin.query('SELECT (SELECT count(*) FROM compliance.notice_publications WHERE hub_id=$1)+(SELECT count(*) FROM compliance.notice_retirements WHERE hub_id=$1) AS n',[hubId])).rows[0].n;
    const seen=[];let before=null;
    do{const page=await owner.history(hubId,{before,limit:2});assert.ok(page.publications.length<=2);seen.push(...page.publications);before=page.next;}while(before);
    assert.equal(seen.length,Number(expected));
    assert.equal(new Set(seen.map(r=>r.kind+'/'+r.purpose+'/'+r.notice_version)).size,seen.length);
    assert.deepEqual(seen,(await owner.history(hubId,{limit:100})).publications);
    assert.equal(seen.at(-1).notice_version,'legacy');assert.equal(seen.at(-1).at,null);
    for(const options of [{limit:0},{limit:101},{limit:'x'},{before:'not-a-cursor'},{before:Buffer.from('{"at":"now"}').toString('base64url')}])
      await assert.rejects(owner.history(hubId,options),{status:400});
  });
  await check('HTTP retirement and history paging are admin-only and shown on the admin screen',async()=>{
    const route=base+'/v1/hubs/'+hubId+'/notices',auth={authorization:'Bearer learner-a'};
    assert.equal((await fetch(route+'/retire',{method:'POST',headers:{authorization:'Bearer learner-b'},body:JSON.stringify({purpose:'survey',expectedVersion:'v1'})})).status,404);
    assert.equal((await fetch(route+'/retire',{method:'POST',headers:auth,body:JSON.stringify({purpose:'survey'})})).status,400);
    assert.equal((await fetch(route+'/retire',{method:'POST',headers:auth,body:JSON.stringify({purpose:'survey',expectedVersion:'v1'})})).status,200);
    const first=await (await fetch(route+'?limit=2',{headers:auth})).json();assert.equal(first.publications.length,2);assert.ok(first.next);
    const second=await fetch(route+'?limit=2&before='+encodeURIComponent(first.next),{headers:auth});assert.equal(second.status,200);
    assert.notDeepEqual((await second.json()).publications,first.publications);
    assert.equal((await fetch(route+'?before=bad',{headers:auth})).status,400);
    const host={host:'learn-new.example',origin:'https://learn-new.example'};
    const exchange=await fetch(base+'/v1/hubs/'+hubId+'/session',{method:'POST',headers:{...host,...auth}});
    const cookie=exchange.headers.get('set-cookie').split(';')[0];
    const html=await (await fetch(base+'/h/'+slug+'/admin',{headers:{...host,cookie}})).text();
    assert.match(html,/<h3>survey<\/h3>\s*<p class="meta"><span class="badge muted">retired<\/span><span>Version <code>v1<\/code>/);assert.ok(!html.includes('data-purpose="survey" data-version="v1">Retire'));
    const member=await (await fetch(base+'/h/'+slug+'/member',{headers:{...host,cookie}})).text();
    assert.ok(!member.includes('data-purpose="survey"'));assert.ok(member.includes('data-purpose="research"'));
  });
}
