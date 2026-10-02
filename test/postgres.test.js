import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PostgresAccessRepository } from '../src/db/access-repository.js';
import { AccessService } from '../src/access.js';
import { MemoryAccessCache } from '../src/cache/memory.js';
import { createApi } from '../src/http/server.js';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { TenantDatabase } from '../src/db/tenant.js';
import { auditPolicies } from '../src/db/policy-audit.js';
import { ConsentRepository } from '../src/db/consent-repository.js';
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
  await admin.query('INSERT INTO identity.users(id) VALUES ($1),($2)',[userA,userB]);
  await admin.query("INSERT INTO identity.org_members(user_id,org_id,status) VALUES ($1,$2,'active'),($3,$4,'active')",[userA,orgA,userB,orgB]);
  await admin.query("INSERT INTO tenancy.memberships(hub_id,user_id,role,status) VALUES ($1,$2,'member','active'),($1,$3,'member','active')",[a,userA,userB]);
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
  server=createApi({authenticate:async token=>token==='learner-a'?{userId:userA}:token==='learner-b'?{userId:userB}:null,
    accessForPrincipal:p=>new AccessService(new PostgresAccessRepository(db,p.userId),cache),
    consentForPrincipal:p=>new ConsentRepository(db,p.userId)});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  const url=base+'/v1/hubs/'+a+'/lessons/'+lesson+'/access';
  const headers={authorization:'Bearer learner-a'};
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
  await admin.query('DELETE FROM compliance.consent_events WHERE hub_id=ANY($1::uuid[])',[[a,b]]);
  await admin.query('DELETE FROM compliance.consents WHERE hub_id=ANY($1::uuid[])',[[a,b]]);
  await admin.query('DELETE FROM compliance.consent_purposes WHERE hub_id=ANY($1::uuid[])',[[a,b]]);
  try{await admin.query('DELETE FROM access.entitlements WHERE hub_id=ANY($1::uuid[])',[[a,b]]);await admin.query('DELETE FROM tenancy.memberships WHERE hub_id=ANY($1::uuid[])',[[a,b]]);await admin.query('DELETE FROM identity.org_members WHERE user_id=ANY($1::uuid[])',[[userA,userB]]);await admin.query('DELETE FROM identity.users WHERE id=ANY($1::uuid[])',[[userA,userB]]);await admin.query('DELETE FROM catalogue.lessons WHERE hub_id=ANY($1::uuid[])',[[a,b]]);await admin.query('DELETE FROM catalogue.products WHERE hub_id=ANY($1::uuid[])',[[a,b]]);await admin.query('DELETE FROM tenancy.boundaries WHERE hub_id=ANY($1::uuid[])',[[a,b]]);await admin.query('DELETE FROM tenancy.hubs WHERE id=ANY($1::uuid[])',[[a,b]]);}finally{await app.end();await admin.end();if(embedded)await embedded.close();}
}
