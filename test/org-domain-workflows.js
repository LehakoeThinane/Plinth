import assert from 'node:assert/strict';
import { TenantDatabase } from '../src/db/tenant.js';
import { OrganisationDomainRepository } from '../src/db/organisation-domain-repository.js';
import { OrganisationRepository } from '../src/db/organisation-repository.js';
import { OrganisationDomains } from '../src/modules/identity/organisation-domains.js';
import { auditPolicies } from '../src/db/policy-audit.js';
export async function organisationDomainChecks({admin,app,domains,db,a,userA,userB,orgId,check,base,fetch,records,testOrgs}) {
  const verifier=new TenantDatabase(domains),resolveTxt=async name=>records.get(name)??[];
  const service=user=>new OrganisationDomains({repository:new OrganisationDomainRepository(db,verifier,user),resolveTxt});
  const owner=service(userA),outsider=service(userB),domain='org-'+orgId+'.company.com';
  const verifiedOwner=()=>admin.query('SELECT org_id FROM identity.org_domains WHERE domain=$1',[domain]).then(r=>r.rows[0]?.org_id);
  let proof;
  await check('organisation domain functions are executor-owned and only the verifier can confirm',async()=>{
    for(const signature of ['app.request_org_domain(uuid,text,text,uuid)','app.org_domain_challenge(uuid,text)','app.confirm_org_domain(uuid,text,text,uuid)',
      'app.remove_org_domain(uuid,text,uuid)','app.organisation_domains(uuid)','app.lock_org_admin(uuid)'])
      assert.equal((await admin.query('SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid=$1::regprocedure',[signature])).rows[0].owner,'plinth_identity_executor');
    await assert.rejects(app.query('SELECT app.confirm_org_domain($1,$2,$3,$4)',[orgId,domain,'0'.repeat(64),orgId]),{code:'42501'});
    await assert.rejects(app.query('SELECT app.lock_org_admin($1)',[orgId]),{code:'42501'});
    await assert.rejects(domains.query('SELECT app.request_org_domain($1,$2,$3,$4)',[orgId,domain,'0'.repeat(64),orgId]),{code:'42501'});
    for(const table of ['identity.org_domain_claims','identity.org_domains'])await assert.rejects(domains.query('SELECT * FROM '+table),{code:'42501'});
    await assert.rejects(app.query('SELECT * FROM identity.org_domain_claims'),{code:'42501'});
    await assert.rejects(db.withSnapshot({hubId:a,userId:userA,orgIds:[],isStaff:false},tx=>tx.query('INSERT INTO identity.org_domains(domain,org_id,verified_by,verified_at) VALUES($1,$2,$3,now())',[domain,orgId,userA])),{code:'42501'});
    for(const [policy,table] of [['member_scope','identity.org_domains'],['executor_scope','identity.org_domain_claims']]) {
      const c=await admin.connect();
      try{await c.query('BEGIN');await c.query('DROP POLICY '+policy+' ON '+table);await assert.rejects(auditPolicies(c),/Unsafe identity policies/);}
      finally{await c.query('ROLLBACK');c.release();}
    }
  });
  await check('only an active organisation admin can create a hashed expiring domain challenge',async()=>{
    proof=await owner.request(a,orgId,{domain});assert.equal(proof.recordName,'_plinth-verification.'+domain);assert.match(proof.recordValue,/^plinth-organisation=[0-9a-f]{64}$/);
    const stored=(await admin.query('SELECT * FROM identity.org_domain_claims WHERE org_id=$1',[orgId])).rows[0];
    assert.notEqual(stored.challenge_hash,proof.recordValue);assert.equal(stored.requested_by,userA);assert.ok(new Date(stored.expires_at)>new Date());
    await assert.rejects(outsider.request(a,orgId,{domain}),{status:404});await assert.rejects(outsider.list(a,orgId),{status:404});
    assert.ok(!JSON.stringify(await owner.list(a,orgId)).includes(stored.challenge_hash));
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM identity.org_events WHERE org_id=$1 AND action='domain_requested'",[orgId])).rows[0].n,1);
  });
  await check('missing and rotated organisation proofs fail; a matching proof verifies once',async()=>{
    await assert.rejects(owner.verify(a,orgId,{domain}),{status:409});
    records.set(proof.recordName,[[proof.recordValue]]);
    const rotated=await owner.request(a,orgId,{domain});await assert.rejects(owner.verify(a,orgId,{domain}),{status:409});
    records.set(rotated.recordName,[[rotated.recordValue.slice(0,40),rotated.recordValue.slice(40)]]);
    assert.equal((await owner.verify(a,orgId,{domain})).domain,domain);await assert.rejects(owner.verify(a,orgId,{domain}),{status:409});
    assert.equal(await verifiedOwner(),orgId);
    assert.deepEqual((await owner.list(a,orgId)).verified.map(d=>d.domain),[domain]);
    const visible=user=>db.withSnapshot({hubId:a,userId:user,orgIds:[],isStaff:false},async tx=>(await tx.query('SELECT domain FROM identity.org_domains WHERE domain=$1',[domain])).rows.length);
    assert.equal(await visible(userA),1);assert.equal(await visible(userB),0);
  });
  await check('expired challenges and admin demotion during DNS prevent verification',async()=>{
    proof=await owner.request(a,orgId,{domain});records.set(proof.recordName,[[proof.recordValue]]);
    await admin.query("UPDATE identity.org_domain_claims SET expires_at=now()-interval '1 second' WHERE org_id=$1",[orgId]);
    await assert.rejects(owner.verify(a,orgId,{domain}),{status:409});
    proof=await owner.request(a,orgId,{domain});
    const demoting=new OrganisationDomains({repository:new OrganisationDomainRepository(db,verifier,userA),resolveTxt:async()=>{
      await admin.query("UPDATE identity.org_members SET role='member' WHERE org_id=$1 AND user_id=$2",[orgId,userA]);return [[proof.recordValue]];}});
    try{await assert.rejects(demoting.verify(a,orgId,{domain}),{status:404});}
    finally{await admin.query("UPDATE identity.org_members SET role='admin' WHERE org_id=$1 AND user_id=$2",[orgId,userA]);}
    await owner.remove(a,orgId,{domain});
  });
  await check('another organisation cannot take a verified domain with its own valid proof',async()=>{
    const otherOrg=(await new OrganisationRepository(db,userB).create(a,{displayName:'Rival',legalName:'Rival Ltd',type:'company'})).id;testOrgs.push(otherOrg);
    await admin.query('INSERT INTO identity.org_domains(domain,org_id,verified_by,verified_at) VALUES($1,$2,$3,now())',[domain,orgId,userA]);
    const rival=await outsider.request(a,otherOrg,{domain});records.set(rival.recordName,[[rival.recordValue]]);
    await assert.rejects(outsider.verify(a,otherOrg,{domain}),{status:409});
    assert.equal(await verifiedOwner(),orgId);
    await assert.rejects(outsider.remove(a,orgId,{domain}),{status:404});assert.equal(await verifiedOwner(),orgId);
  });
  await check('HTTP organisation domain administration is CSRF protected, admin-only and removable',async()=>{
    const route=base+'/v1/hubs/'+a+'/organisations/'+orgId+'/domains',bearer={authorization:'Bearer learner-a'};
    const session=await fetch(base+'/v1/hubs/'+a+'/session',{method:'POST',headers:{...bearer,host:'learn-a.example',origin:'https://learn-a.example'}});
    const cookie=session.headers.get('set-cookie').split(';')[0],csrf=(await session.json()).csrfToken;
    const browser={cookie,host:'learn-a.example',origin:'https://learn-a.example'},other='http-'+domain;
    assert.equal((await fetch(route,{method:'POST',headers:browser,body:JSON.stringify({domain:other})})).status,403);
    const created=await fetch(route,{method:'POST',headers:{...browser,'x-csrf-token':csrf},body:JSON.stringify({domain:other})});assert.equal(created.status,200);
    const httpProof=await created.json();records.set(httpProof.recordName,[[httpProof.recordValue]]);
    assert.equal((await fetch(route+'/verify',{method:'POST',headers:{authorization:'Bearer learner-b'},body:JSON.stringify({domain:other})})).status,404);
    assert.equal((await fetch(route+'/verify',{method:'POST',headers:bearer,body:JSON.stringify({domain:other,verified:true})})).status,200);
    const listing=await fetch(route,{headers:bearer});assert.equal(listing.status,200);
    const text=await listing.text();assert.ok(text.includes(other));assert.ok(!text.includes('challenge'));
    const page=await fetch(base+'/h/test-'+a+'/organisations?org='+orgId,{headers:{cookie,host:'learn-a.example'}});
    const html=await page.text();assert.ok(html.includes('id="org-domain-request"'));assert.ok(html.includes(other));
    assert.equal((await fetch(route,{method:'DELETE',headers:bearer,body:JSON.stringify({domain:other})})).status,200);
    assert.equal((await fetch(route,{method:'DELETE',headers:bearer,body:JSON.stringify({domain:other})})).status,404);
    assert.equal((await fetch(route,{method:'POST',headers:bearer,body:JSON.stringify({domain:'localhost'})})).status,400);
    await fetch(base+'/v1/hubs/'+a+'/session',{method:'DELETE',headers:{...browser,'x-csrf-token':csrf}});
  });
}
