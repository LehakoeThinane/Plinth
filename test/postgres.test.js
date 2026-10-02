import assert from 'node:assert/strict';
import { once } from 'node:events';
import { MemoryAccessCache } from '../src/cache/memory.js';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { TenantDatabase } from '../src/db/tenant.js';
import { auditPolicies } from '../src/db/policy-audit.js';
import { ConsentRepository } from '../src/db/consent-repository.js';
import { IdentityRepository } from '../src/db/identity-repository.js';
import { createApplication } from '../src/app.js';
import { HubRepository } from '../src/db/hub-repository.js';
const embeddedMode=process.env.PLINTH_EMBEDDED_TEST==='1';
if (!embeddedMode && (!process.env.DATABASE_URL || !process.env.TEST_ADMIN_DATABASE_URL)) throw Error('Real PostgreSQL URLs are required; integration tests cannot be skipped.');
const embedded=embeddedMode?await (await import('./embedded-postgres.js')).createEmbeddedPools():null;
const admin=embedded?.admin??new pg.Pool({connectionString:process.env.TEST_ADMIN_DATABASE_URL,connectionTimeoutMillis:2000});
const app=embedded?.app??new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:2000});
const db=new TenantDatabase(app);
const a=randomUUID(),b=randomUUID(),orgA=randomUUID(),orgB=randomUUID();
const publicBoundary=randomUUID(),privateBoundary=randomUUID(),otherBoundary=randomUUID();
const publicProduct=randomUUID(),privateProduct=randomUUID(),otherProduct=randomUUID(),lesson=randomUUID();
const context={hubId:a,orgIds:[orgA],isStaff:false};
const userA=randomUUID(),userB=randomUUID(),entitlement=randomUUID();
const testHubs=[a,b];
const hostname='learn-'+a+'.example.com';
let server;
let count=0;
async function check(name,fn){await fn();count++;console.log('PASS '+name);}
try {
  await check('application role cannot bypass RLS and owns no tenant tables',async()=>{
    const r=await app.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user');
    assert.equal(r.rows[0].rolsuper,false);assert.equal(r.rows[0].rolbypassrls,false);
    const owned=await app.query("SELECT count(*)::int AS n FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND relnamespace IN (SELECT oid FROM pg_namespace WHERE nspname IN ('tenancy','catalogue'))");assert.equal(owned.rows[0].n,0);
  });
  await check('policy audit passes baseline',()=>auditPolicies(admin));
  await admin.query('INSERT INTO tenancy.hubs(id,slug) VALUES ($1,$3),($2,$4)',[a,b,'test-'+a,'test-'+b]);
  await admin.query("INSERT INTO tenancy.hub_profiles(hub_id,display_name) VALUES ($1,'Hub A'),($2,'Hub B')",[a,b]);
  await admin.query('INSERT INTO tenancy.hub_domains(hub_id,hostname,verified_at) VALUES ($1,$2,now()),($3,$4,NULL)',[a,hostname,b,'pending-'+b+'.example.com']);
  await admin.query("INSERT INTO identity.organisations(id,display_name) VALUES ($1,'Company A'),($2,'Company B')",[orgA,orgB]);
  await admin.query('INSERT INTO tenancy.boundaries(hub_id,id,company_org) VALUES ($1,$2,NULL),($1,$3,$4),($5,$6,$7)',[a,publicBoundary,privateBoundary,orgA,b,otherBoundary,orgB]);
  await admin.query("INSERT INTO catalogue.products(hub_id,id,boundary_id,title,visibility) VALUES ($1,$2,$3,'public','public'),($1,$4,$5,'private','company'),($6,$7,$8,'other','company')",[a,publicProduct,publicBoundary,privateProduct,privateBoundary,b,otherProduct,otherBoundary]);
  await admin.query("INSERT INTO catalogue.lessons(hub_id,id,product_id,boundary_id,title) VALUES ($1,$2,$3,$4,'private lesson')",[a,lesson,privateProduct,privateBoundary]);
  await check('company member sees own company product and lesson',()=>db.withSnapshot(context,async tx=>{
    assert.equal((await tx.query('SELECT * FROM catalogue.products')).rows.length,2);
    assert.equal((await tx.query('SELECT * FROM catalogue.lessons')).rows.length,1);
  }));
  await check('other company cannot see private parent or child',()=>db.withSnapshot({...context,orgIds:[orgB]},async tx=>{
    assert.equal((await tx.query('SELECT * FROM catalogue.products')).rows.length,1);
    assert.equal((await tx.query('SELECT * FROM catalogue.lessons')).rows.length,0);
  }));
  await check('cross-hub reads return no rows',()=>db.withSnapshot(context,async tx=>{
    assert.equal((await tx.query('SELECT * FROM catalogue.products WHERE id=$1',[otherProduct])).rows.length,0);
  }));
  await check('learners cannot edit catalogue',()=>db.withSnapshot(context,async tx=>{
    assert.equal((await tx.query("UPDATE catalogue.products SET title='changed' WHERE id=$1 RETURNING id",[publicProduct])).rows.length,0);
  }));
  await check('staff cannot insert another hub row',async()=>{
    await assert.rejects(db.withSnapshot({...context,isStaff:true},tx=>tx.query("INSERT INTO catalogue.products VALUES ($1,$2,$3,'bad','company')",[b,randomUUID(),otherBoundary])),{code:'42501'});
  });
  await check('staff cannot move a product across hubs',async()=>{
    await assert.rejects(db.withSnapshot({...context,isStaff:true},tx=>tx.query('UPDATE catalogue.products SET hub_id=$1 WHERE id=$2',[b,publicProduct])),{code:'42501'});
  });
  await check('child cannot change inherited boundary',async()=>{
    await assert.rejects(db.withSnapshot({...context,isStaff:true},tx=>tx.query('UPDATE catalogue.lessons SET boundary_id=$1 WHERE id=$2',[publicBoundary,lesson])),{code:'23503'});
  });
  await check('child boundary cannot be null',async()=>{
    await assert.rejects(db.withSnapshot({...context,isStaff:true},tx=>tx.query('UPDATE catalogue.lessons SET boundary_id=NULL WHERE id=$1',[lesson])),{code:'42501'});
    await assert.rejects(admin.query('UPDATE catalogue.lessons SET boundary_id=NULL WHERE id=$1',[lesson]),{code:'23502'});
  });
  await check('tenant context does not leak through pooled connection',async()=>{
    assert.equal((await app.query('SELECT * FROM catalogue.products')).rows.length,0);
    await db.withSnapshot({...context,hubId:b,orgIds:[orgB]},async tx=>assert.equal((await tx.query('SELECT * FROM catalogue.products')).rows.length,1));
    assert.equal((await app.query('SELECT * FROM catalogue.products')).rows.length,0);
  });
  await check('policy harness rejects a missing restrictive policy',async()=>{
    const c=await admin.connect();try {await c.query('BEGIN');await c.query('DROP POLICY company_scope ON catalogue.lessons');await assert.rejects(auditPolicies(c),/Unsafe/);}finally{await c.query('ROLLBACK');c.release();}
  });
  await check('policy harness rejects disabled RLS',async()=>{
    const c=await admin.connect();try{await c.query('BEGIN');await c.query('ALTER TABLE catalogue.lessons DISABLE ROW LEVEL SECURITY');await assert.rejects(auditPolicies(c),/Unsafe/);}finally{await c.query('ROLLBACK');c.release();}
  });
  await check('policy harness rejects a permissive policy widening tenant access',async()=>{
    const c=await admin.connect();try{await c.query('BEGIN');await c.query('CREATE POLICY accidental_allow ON catalogue.lessons USING (true) WITH CHECK (true)');await assert.rejects(auditPolicies(c),/Unsafe/);}finally{await c.query('ROLLBACK');c.release();}
  });
  await check('policy harness rejects missing global identity isolation',async()=>{
    const c=await admin.connect();try{
      await c.query('BEGIN');await c.query('DROP POLICY member_scope ON identity.organisations');
      await assert.rejects(auditPolicies(c),/Unsafe identity/);
    }finally{await c.query('ROLLBACK');c.release();}
  });
  await check('policy harness rejects disabled SSO configuration isolation',async()=>{
    const c=await admin.connect();try{
      await c.query('BEGIN');await c.query('ALTER TABLE identity.sso_configurations DISABLE ROW LEVEL SECURITY');
      await assert.rejects(auditPolicies(c),/Unsafe identity/);
    }finally{await c.query('ROLLBACK');c.release();}
  });
  await admin.query('INSERT INTO identity.users(id) VALUES ($1),($2)',[userA,userB]);
  await admin.query("INSERT INTO identity.org_members(user_id,org_id,status) VALUES ($1,$2,'active'),($3,$4,'active')",[userA,orgA,userB,orgB]);
  const issuer='https://identity.example/'+a;
  await admin.query('INSERT INTO identity.auth_links(issuer,subject,user_id) VALUES ($1,$2,$3)',[issuer,'subject-a',userA]);
  const identityA=new IdentityRepository(db,userA),identityB=new IdentityRepository(db,userB);
  await check('global account and organisation reads stay scoped to the verified user',async()=>{
    const account=await identityA.account(a);
    assert.equal(account.user.id,userA);
    assert.deepEqual(account.organisations.map(o=>o.id),[orgA]);
    assert.equal((await identityA.account(b)).user.id,userA);
    assert.deepEqual((await identityB.account(a)).organisations.map(o=>o.id),[orgB]);
    await db.withSnapshot({...context,userId:userB},async tx=>assert.equal((await tx.query('SELECT * FROM identity.auth_links')).rows.length,0));
  });
  await check('issuer and subject cannot be linked to a second global account',async()=>{
    await assert.rejects(admin.query('INSERT INTO identity.auth_links(issuer,subject,user_id) VALUES ($1,$2,$3)',[issuer,'subject-a',userB]),{code:'23505'});
    await assert.rejects(db.withSnapshot({...context,userId:userA},tx=>tx.query('INSERT INTO identity.auth_links(issuer,subject,user_id) VALUES ($1,$2,$3)',[issuer,'forged',userA])),{code:'42501'});
  });
  await admin.query("INSERT INTO identity.sso_configurations(org_id,protocol,issuer,client_id) VALUES ($1,'oidc',$2,'company-client')",[orgA,issuer]);
  await check('company SSO configuration is visible only to an active organisation admin',async()=>{
    await assert.rejects(identityA.ssoConfiguration(a,orgA),{status:404});
    await admin.query("UPDATE identity.org_members SET role='admin' WHERE user_id=$1",[userA]);
    assert.equal((await identityA.ssoConfiguration(a,orgA)).enabled,false);
    await assert.rejects(identityB.ssoConfiguration(a,orgA),{status:404});
    await admin.query("UPDATE identity.org_members SET status='ended' WHERE user_id=$1",[userA]);
    await assert.rejects(identityA.ssoConfiguration(a,orgA),{status:404});
    assert.equal((await identityA.account(a)).organisations.length,0);
    await admin.query("UPDATE identity.org_members SET status='active',role='member' WHERE user_id=$1",[userA]);
  });
  await check('runtime cannot elevate organisation roles or activate unfinished SSO',async()=>{
    await assert.rejects(db.withSnapshot({...context,userId:userA},tx=>tx.query("UPDATE identity.org_members SET role='admin'")),{code:'42501'});
    await assert.rejects(admin.query('UPDATE identity.sso_configurations SET enabled=true WHERE org_id=$1',[orgA]),{code:'23514'});
    await assert.rejects(admin.query("INSERT INTO identity.org_members(user_id,org_id,status) VALUES ($1,$2,'active')",[userA,randomUUID()]),{code:'23503'});
  });
  await admin.query("INSERT INTO tenancy.memberships(hub_id,user_id,role,status) VALUES ($1,$2,'member','active'),($1,$3,'member','active')",[a,userA,userB]);
  const publicHubs=new HubRepository(db),hubsA=new HubRepository(db,userA);
  await check('public hub lookup resolves only the requested slug or verified domain',async()=>{
    assert.equal((await publicHubs.resolve({slug:'test-'+a})).id,a);
    assert.equal((await publicHubs.resolve({hostname})).id,a);
    await assert.rejects(publicHubs.resolve({hostname:'pending-'+b+'.example.com'}),{status:404});
    await assert.rejects(publicHubs.resolve({slug:'test-'+a,hostname}),{status:400});
    await assert.rejects(publicHubs.resolve({hostname:'https://'+hostname}),{status:400});
    assert.deepEqual(Object.keys(await publicHubs.resolve({slug:'test-'+a})).sort(),['id','slug','display_name','description','primary_color','font','logo_path'].sort());
  });
  await check('creation rolls back the hub and owner if profile validation fails',async()=>{
    const newHub=randomUUID(),badSlug='rollback-'+newHub;
    await assert.rejects(db.withSnapshot({...context,hubId:newHub,userId:userA},tx=>tx.query('SELECT app.create_hub($1,$2)',[badSlug,''])),{code:'23514'});
    assert.equal((await admin.query('SELECT id FROM tenancy.hubs WHERE id=$1',[newHub])).rows.length,0);
    assert.equal((await admin.query('SELECT * FROM tenancy.memberships WHERE hub_id=$1',[newHub])).rows.length,0);
  });
  await check('hub profile and domain tables enforce tenant isolation',async()=>{
    await db.withSnapshot({...context,userId:userA},async tx=>{
      assert.equal((await tx.query('SELECT * FROM tenancy.hub_profiles WHERE hub_id=$1',[b])).rows.length,0);
      assert.equal((await tx.query('SELECT * FROM tenancy.hub_domains')).rows.length,0);
    });
    await assert.rejects(db.withSnapshot({...context,userId:userA},tx=>tx.query("INSERT INTO tenancy.memberships(hub_id,user_id,role,status) VALUES ($1,$2,'owner','active')",[b,userA])),{code:'42501'});
    await assert.rejects(db.withSnapshot({...context,userId:userA},tx=>tx.query('UPDATE tenancy.hub_domains SET verified_at=now()')),{code:'42501'});
  });
  await admin.query("INSERT INTO compliance.consent_purposes(hub_id,purpose,notice_version,notice_text) VALUES ($1,'marketing','v1','Hub A marketing'),($2,'marketing','v1','Hub B marketing')",[a,b]);
  const consentA=new ConsentRepository(db,userA),consentB=new ConsentRepository(db,userB);
  await check('consent grant and withdrawal preserve an audit trail',async()=>{
    await consentA.set(a,{purpose:'marketing',granted:true,noticeVersion:'v1'});
    assert.equal((await consentA.list(a))[0].granted,true);
    await consentA.set(a,{purpose:'marketing',granted:false,noticeVersion:'v1'});
    assert.equal((await consentA.list(a))[0].granted,false);
    const events=await admin.query('SELECT granted,notice_text FROM compliance.consent_events WHERE hub_id=$1 AND user_id=$2 ORDER BY id',[a,userA]);
    assert.deepEqual(events.rows.map(r=>r.granted),[true,false]);
    assert.equal(events.rows[0].notice_text,'Hub A marketing');
  });
  await check('consent is isolated by user and hub',async()=>{
    assert.equal((await consentB.list(a))[0].granted,false);
    await assert.rejects(consentA.set(b,{purpose:'marketing',granted:true,noticeVersion:'v1'}),{status:404});
    await db.withSnapshot({...context,userId:userA},async tx=>{
      assert.equal((await tx.query('SELECT * FROM compliance.consent_events WHERE hub_id=$1',[b])).rows.length,0);
      assert.equal((await tx.query('SELECT * FROM compliance.consents WHERE user_id=$1',[userB])).rows.length,0);
    });
  });
  await check('stale notices and invalid decisions cannot grant consent',async()=>{
    await assert.rejects(consentA.set(a,{purpose:'marketing',granted:true,noticeVersion:'old'}),{status:409});
    await assert.rejects(consentA.set(a,{purpose:'marketing',granted:'yes',noticeVersion:'v1'}),{status:400});
    await assert.rejects(db.withSnapshot({...context,userId:userA},tx=>tx.query("UPDATE compliance.consents SET notice_version='old'")),{code:'23514'});
  });
  await check('runtime cannot edit or delete consent audit records',async()=>{
    await assert.rejects(db.withSnapshot({...context,userId:userA},tx=>tx.query('DELETE FROM compliance.consent_events')),{code:'42501'});
    await assert.rejects(db.withSnapshot({...context,userId:userA},tx=>tx.query("UPDATE compliance.consent_events SET granted=true")),{code:'42501'});
  });
  await check('new notice invalidates prior grant without rewriting audit history',async()=>{
    await consentA.set(a,{purpose:'marketing',granted:true,noticeVersion:'v1'});
    await admin.query("UPDATE compliance.consent_purposes SET notice_version='v2',notice_text='Revised notice' WHERE hub_id=$1",[a]);
    assert.equal((await consentA.list(a))[0].granted,false);
    await assert.rejects(consentA.set(a,{purpose:'marketing',granted:true,noticeVersion:'v1'}),{status:409});
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM compliance.consent_events WHERE hub_id=$1 AND notice_text='Hub A marketing'",[a])).rows[0].n,3);
    await admin.query("UPDATE compliance.consent_purposes SET notice_version='v1',notice_text='Hub A marketing' WHERE hub_id=$1",[a]);
  });
  await admin.query("UPDATE catalogue.products SET status='published' WHERE hub_id=$1",[a]);
  await admin.query("UPDATE catalogue.lessons SET status='published' WHERE hub_id=$1",[a]);
  await admin.query('INSERT INTO access.entitlements(hub_id,id,user_id,target_id) VALUES ($1,$2,$3,$4)',[a,entitlement,userA,privateProduct]);
  const cache=new MemoryAccessCache();
  server=createApplication({pool:app,cache,authenticate:async token=>token==='learner-a'?{userId:userA}:token==='learner-b'?{userId:userB}:null});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  const url=base+'/v1/hubs/'+a+'/lessons/'+lesson+'/access';
  const headers={authorization:'Bearer learner-a'};
  let createdHub,createdSlug;
  await check('HTTP creates a hub with an owner and rejects duplicate slugs',async()=>{
    const slug='new-'+randomUUID(),body=JSON.stringify({slug,displayName:'Created Hub',role:'admin',userId:userB});
    assert.equal((await fetch(base+'/v1/hubs',{method:'POST',body})).status,401);
    const response=await fetch(base+'/v1/hubs',{method:'POST',headers,body});
    assert.equal(response.status,201);const created=await response.json();createdHub=created.id;createdSlug=created.slug;testHubs.push(createdHub);
    assert.deepEqual(await hubsA.membership(createdHub),{role:'owner',status:'active'});
    assert.equal((await fetch(base+'/v1/hubs',{method:'POST',headers,body})).status,409);
    const resolved=await fetch(base+'/v1/hubs/resolve?slug='+slug);
    assert.equal(resolved.status,200);assert.equal((await resolved.json()).id,createdHub);
  });
  await check('joining twice is idempotent and cannot request an elevated role',async()=>{
    const joinUrl=base+'/v1/hubs/'+createdHub+'/join';
    for(let i=0;i<2;i++) {
      const response=await fetch(joinUrl,{method:'POST',headers:{authorization:'Bearer learner-b','x-role':'owner'},body:JSON.stringify({role:'owner'})});
      assert.equal(response.status,200);assert.deepEqual(await response.json(),{role:'member',status:'active'});
    }
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM tenancy.memberships WHERE hub_id=$1 AND user_id=$2',[createdHub,userB])).rows[0].n,1);
  });
  await check('only active owner/admin can brand a hub and script configuration is rejected',async()=>{
    const brandingUrl=base+'/v1/hubs/'+createdHub+'/branding';
    assert.equal((await fetch(brandingUrl,{method:'PUT',headers:{authorization:'Bearer learner-b','x-is-staff':'true'},body:JSON.stringify({displayName:'Hijacked'})})).status,404);
    const updated=await fetch(brandingUrl,{method:'PUT',headers,body:JSON.stringify({displayName:'Branded Hub',primaryColor:'#123ABC',font:'serif'})});
    assert.equal(updated.status,200);assert.equal((await updated.json()).display_name,'Branded Hub');
    for(const branding of [{script:'alert(1)'},{primaryColor:'red;display:none'},{font:'url(https://evil.example)'},{logoPath:'/assets/hubs/'+b+'/branding/logo.png'}]) {
      assert.equal((await fetch(brandingUrl,{method:'PUT',headers,body:JSON.stringify(branding)})).status,400);
    }
    await assert.rejects(db.withSnapshot({...context,hubId:createdHub,userId:userA},tx=>tx.query("UPDATE tenancy.hub_profiles SET primary_color='red;display:none'")),{code:'23514'});
    await assert.rejects(db.withSnapshot({...context,hubId:createdHub,userId:userA},tx=>tx.query('UPDATE tenancy.hub_profiles SET logo_path=$1',['/assets/hubs/'+b+'/branding/logo.png'])),{code:'23514'});
    await admin.query("UPDATE tenancy.memberships SET status='suspended' WHERE hub_id=$1 AND user_id=$2",[createdHub,userA]);
    assert.equal((await fetch(brandingUrl,{method:'PUT',headers,body:JSON.stringify({displayName:'Stale owner'})})).status,404);
    await admin.query("UPDATE tenancy.memberships SET status='active' WHERE hub_id=$1 AND user_id=$2",[createdHub,userA]);
  });
  await check('closed hubs and ended memberships cannot be joined to regain access',async()=>{
    await admin.query("UPDATE tenancy.hub_profiles SET join_mode='closed' WHERE hub_id=$1",[b]);
    assert.equal((await fetch(base+'/v1/hubs/'+b+'/join',{method:'POST',headers})).status,404);
    assert.equal((await fetch(base+'/v1/hubs/'+b+'/membership',{headers})).status,404);
    await admin.query("UPDATE tenancy.memberships SET status='ended' WHERE hub_id=$1 AND user_id=$2",[createdHub,userB]);
    assert.equal((await fetch(base+'/v1/hubs/'+createdHub+'/join',{method:'POST',headers:{authorization:'Bearer learner-b'}})).status,404);
  });
  await check('unknown/unverified domain lookup cannot be overridden by forwarded headers',async()=>{
    const response=await fetch(base+'/v1/hubs/resolve?hostname=pending-'+b+'.example.com',{headers:{'x-forwarded-host':hostname}});
    assert.equal(response.status,404);
  });
  await check('public storefront renders branding as text and blocks provider script execution',async()=>{
    const malicious='<script>alert(1)</script>';
    await hubsA.brand(createdHub,{displayName:malicious,description:'Learn safely <img src=x onerror=alert(1)>'});
    const response=await fetch(base+'/h/'+createdSlug);
    assert.equal(response.status,200);
    assert.match(response.headers.get('content-type'),/text\/html/);
    assert.match(response.headers.get('content-security-policy'),/default-src 'none'/);
    assert.equal(response.headers.get('set-cookie'),null);
    const html=await response.text();
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('<img src=x'));
  });
  await check('authenticated consent API ignores forged user headers',async()=>{
    const consentUrl=base+'/v1/hubs/'+a+'/consents';
    assert.equal((await fetch(consentUrl)).status,401);
    const response=await fetch(consentUrl,{method:'PUT',headers:{...headers,'x-user-id':userB},body:JSON.stringify({purpose:'marketing',granted:true,noticeVersion:'v1'})});
    assert.equal(response.status,200);
    assert.equal((await consentA.list(a))[0].granted,true);
    assert.equal((await consentB.list(a))[0].granted,false);
    assert.equal((await fetch(base+'/v1/hubs/'+b+'/consents',{method:'PUT',headers,body:JSON.stringify({purpose:'marketing',granted:true,noticeVersion:'v1'})})).status,404);
  });
  await check('database-backed HTTP allows entitled learner',async()=>{const r=await fetch(url,{headers});assert.equal(r.status,200);assert.equal((await r.json()).decision,'allowed');});
  await check('database-backed HTTP hides company lesson from other company',async()=>{const r=await fetch(url,{headers:{authorization:'Bearer learner-b','x-is-staff':'true','x-org-ids':orgA}});assert.equal(r.status,404);});
  await check('database-backed HTTP hides cross-hub resource',async()=>{const r=await fetch(base+'/v1/hubs/'+b+'/lessons/'+lesson+'/access',{headers});assert.equal(r.status,404);});
  await check('expired entitlement blocks database-backed HTTP access',async()=>{
    await admin.query("UPDATE access.entitlements SET expires_at=now()-interval '1 second' WHERE id=$1",[entitlement]);assert.equal((await fetch(url,{headers})).status,404);
    await admin.query('UPDATE access.entitlements SET expires_at=NULL WHERE id=$1',[entitlement]);
  });
  await check('database-triggered seat/entitlement revocation defeats cached allow',async()=>{await admin.query('UPDATE access.entitlements SET revoked=true WHERE id=$1',[entitlement]);assert.equal((await fetch(url,{headers})).status,404);});
  await admin.query('UPDATE access.entitlements SET revoked=false WHERE id=$1',[entitlement]);
  await check('company removal prevents access despite retained entitlement',async()=>{await admin.query("UPDATE identity.org_members SET status='ended' WHERE user_id=$1",[userA]);assert.equal((await fetch(url,{headers})).status,404);});
  await admin.query("UPDATE identity.org_members SET status='active' WHERE user_id=$1",[userA]);
  await check('suspended staff cannot use stale staff context',async()=>{await admin.query("UPDATE tenancy.memberships SET role='admin',status='suspended' WHERE user_id=$1",[userA]);assert.equal((await fetch(url,{headers})).status,404);});
  await check('suspended members can withdraw but cannot grant consent',async()=>{
    await consentA.set(a,{purpose:'marketing',granted:false,noticeVersion:'v1'});
    await assert.rejects(consentA.set(a,{purpose:'marketing',granted:true,noticeVersion:'v1'}),{status:404});
  });
  console.log(count+' PostgreSQL integration checks passed');
} finally {
  if(server)await new Promise(resolve=>server.close(resolve));
  try {
  await admin.query('DELETE FROM compliance.consent_events WHERE hub_id=ANY($1::uuid[])',[[a,b]]);
  await admin.query('DELETE FROM compliance.consents WHERE hub_id=ANY($1::uuid[])',[[a,b]]);
  await admin.query('DELETE FROM compliance.consent_purposes WHERE hub_id=ANY($1::uuid[])',[[a,b]]);
  await admin.query('DELETE FROM identity.auth_links WHERE user_id=ANY($1::uuid[])',[[userA,userB]]);
  await admin.query('DELETE FROM identity.sso_configurations WHERE org_id=ANY($1::uuid[])',[[orgA,orgB]]);
  await admin.query('DELETE FROM access.entitlements WHERE hub_id=ANY($1::uuid[])',[[a,b]]);
  await admin.query('DELETE FROM tenancy.memberships WHERE hub_id=ANY($1::uuid[])',[testHubs]);
  await admin.query('DELETE FROM identity.org_members WHERE user_id=ANY($1::uuid[])',[[userA,userB]]);
  await admin.query('DELETE FROM identity.users WHERE id=ANY($1::uuid[])',[[userA,userB]]);
  await admin.query('DELETE FROM catalogue.lessons WHERE hub_id=ANY($1::uuid[])',[[a,b]]);
  await admin.query('DELETE FROM catalogue.products WHERE hub_id=ANY($1::uuid[])',[[a,b]]);
  await admin.query('DELETE FROM tenancy.boundaries WHERE hub_id=ANY($1::uuid[])',[[a,b]]);
  await admin.query('DELETE FROM tenancy.hub_domains WHERE hub_id=ANY($1::uuid[])',[testHubs]);
  await admin.query('DELETE FROM tenancy.hub_profiles WHERE hub_id=ANY($1::uuid[])',[testHubs]);
  await admin.query('DELETE FROM tenancy.hubs WHERE id=ANY($1::uuid[])',[testHubs]);
  await admin.query('DELETE FROM identity.organisations WHERE id=ANY($1::uuid[])',[[orgA,orgB]]);
  } finally { await app.end();await admin.end();if(embedded)await embedded.close(); }
}
