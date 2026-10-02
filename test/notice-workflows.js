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
    await owner.publish(hubId,input);const history=await owner.history(hubId);assert.equal(history[0].published_by,userA);assert.equal(history[0].notice_text,input.noticeText);
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
    assert.equal((await owner.history(hubId)).length,2);
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
}
