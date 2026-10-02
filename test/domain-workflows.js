import assert from 'node:assert/strict';
import { DomainRepository } from '../src/db/domain-repository.js';
import { DomainVerification } from '../src/modules/tenancy/domain-verification.js';
import { TenantDatabase } from '../src/db/tenant.js';
import { auditPolicies } from '../src/db/policy-audit.js';
export async function domainChecks({admin,app,domains,db,hubId,otherHub,userA,userB,check,base,fetch,records,slug,embeddedMode}) {
  const repository=new DomainRepository(db,new TenantDatabase(domains),userA),service=new DomainVerification({repository,resolveTxt:async name=>records.get(name)??[]});
  const hostname='learn-'+hubId+'.company.com',url=base+'/v1/hubs/'+hubId+'/domains',headers={authorization:'Bearer learner-a','content-type':'application/json'};
  let proof;
  await check('only the function-only verifier can confirm ownership and executor cannot bypass RLS',async()=>{
    for(const role of ['plinth_domain_executor','plinth_domain_verifier']) {
      const info=(await admin.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=$1',[role])).rows[0];assert.deepEqual(info,{rolsuper:false,rolbypassrls:false});
      assert.equal((await admin.query("SELECT pg_has_role('plinth_app',$1,'MEMBER') AS member",[role])).rows[0].member,false);
    }
    await assert.rejects(app.query("SELECT app.confirm_domain('learn.company.com','forged')"),{code:'42501'});
    await assert.rejects(domains.query('SELECT * FROM tenancy.domain_claims'),{code:'42501'});
    if(!embeddedMode)await assert.rejects(domains.query('SET ROLE plinth_domain_executor'),{code:'42501'});
    const connection=await admin.connect();
    try{await connection.query('BEGIN');await connection.query('DROP POLICY admin_scope ON tenancy.domain_claims');await assert.rejects(auditPolicies(connection),/Unsafe domain/);}
    finally{await connection.query('ROLLBACK');connection.release();}
  });
  await check('admin can create a hashed expiring challenge; non-admin and cross-hub requests fail',async()=>{
    proof=await service.request(hubId,{hostname});assert.equal(proof.hostname,hostname);
    assert.equal((await (new DomainRepository(db,new TenantDatabase(domains),userB)).list(hubId).catch(e=>e)).status,404);
    await assert.rejects(service.request(otherHub,{hostname}),{status:404});
    const stored=(await admin.query('SELECT * FROM tenancy.domain_claims WHERE hub_id=$1',[hubId])).rows[0];assert.notEqual(stored.challenge_hash,proof.recordValue);assert.equal(stored.requested_by,userA);
    assert.ok(new Date(stored.expires_at)>new Date());
    assert.equal((await fetch(base+'/v1/hubs/resolve?hostname='+hostname)).status,404);
  });
  await check('missing and rotated DNS proof cannot claim a hostname; matching proof consumes once',async()=>{
    await assert.rejects(service.verify(hubId,{hostname}),{status:409});
    records.set(proof.recordName,[[proof.recordValue]]);
    const rotated=await service.request(hubId,{hostname});await assert.rejects(service.verify(hubId,{hostname}),{status:409});
    records.set(rotated.recordName,[[rotated.recordValue.slice(0,25),rotated.recordValue.slice(25)]]);
    await service.verify(hubId,{hostname});await assert.rejects(service.verify(hubId,{hostname}),{status:409});
    const resolved=await fetch(base+'/v1/hubs/resolve?hostname='+hostname);assert.equal(resolved.status,200);assert.equal((await resolved.json()).id,hubId);
  });
  await check('expired challenges and admin revocation during DNS prevent publication',async()=>{
    const beforeRotation=await service.request(hubId,{hostname});
    const rotatedDuringDns=new DomainVerification({repository,resolveTxt:async()=>{await service.request(hubId,{hostname});return [[beforeRotation.recordValue]];}});
    await assert.rejects(rotatedDuringDns.verify(hubId,{hostname}),{status:409});
    proof=await service.request(hubId,{hostname});records.set(proof.recordName,[[proof.recordValue]]);
    await admin.query("UPDATE tenancy.domain_claims SET expires_at=now()-interval '1 second' WHERE hub_id=$1",[hubId]);
    await assert.rejects(service.verify(hubId,{hostname}),{status:409});
    proof=await service.request(hubId,{hostname});
    const revoked=new DomainVerification({repository,resolveTxt:async()=>{await admin.query("UPDATE tenancy.memberships SET status='suspended' WHERE hub_id=$1 AND user_id=$2",[hubId,userA]);return [[proof.recordValue]];}});
    try{await assert.rejects(revoked.verify(hubId,{hostname}),{status:404});}
    finally{await admin.query("UPDATE tenancy.memberships SET status='active' WHERE hub_id=$1 AND user_id=$2",[hubId,userA]);}
  });
  await check('valid proof cannot steal an existing other-hub hostname or rewrite verification directly',async()=>{
    await admin.query('DELETE FROM tenancy.hub_domains WHERE hub_id=$1 AND hostname=$2',[hubId,hostname]);
    await admin.query('INSERT INTO tenancy.hub_domains(hub_id,hostname,verified_at) VALUES($1,$2,now())',[otherHub,hostname]);
    proof=await service.request(hubId,{hostname});records.set(proof.recordName,[[proof.recordValue]]);
    await assert.rejects(service.verify(hubId,{hostname}),e=>[404,409].includes(e.status));
    assert.equal((await admin.query('SELECT hub_id FROM tenancy.hub_domains WHERE hostname=$1',[hostname])).rows[0].hub_id,otherHub);
    await assert.rejects(app.query('UPDATE tenancy.hub_domains SET verified_at=now()'),{code:'42501'});
    await admin.query('DELETE FROM tenancy.hub_domains WHERE hub_id=$1 AND hostname=$2',[otherHub,hostname]);
  });
  await check('HTTP domain administration is CSRF protected, private and removable',async()=>{
    const session=await fetch(base+'/v1/hubs/'+hubId+'/session',{method:'POST',headers:{authorization:'Bearer learner-a',host:'learn-new.example',origin:'https://learn-new.example'}});
    const cookie=session.headers.get('set-cookie').split(';')[0],csrf=(await session.json()).csrfToken,browser={cookie,host:'learn-new.example',origin:'https://learn-new.example','content-type':'application/json'};
    assert.equal((await fetch(url,{method:'POST',headers:browser,body:JSON.stringify({hostname})})).status,403);
    const response=await fetch(url,{method:'POST',headers:{...browser,'x-csrf-token':csrf},body:JSON.stringify({hostname})});assert.equal(response.status,200);proof=await response.json();
    records.set(proof.recordName,[[proof.recordValue]]);
    assert.equal((await fetch(url+'/verify',{method:'POST',headers,body:JSON.stringify({hostname,verified:true})})).status,200);
    const listing=await fetch(url,{headers});assert.equal(listing.status,200);assert.ok(!(await listing.text()).includes('challenge_hash'));
    const page=await fetch(base+'/h/'+slug+'/admin',{headers:{cookie,host:'learn-new.example'}});assert.equal(page.status,200);assert.ok((await page.text()).includes('id="domain-request"'));
    assert.equal((await fetch(url,{method:'DELETE',headers,body:JSON.stringify({hostname})})).status,200);
    assert.equal((await fetch(base+'/v1/hubs/resolve?hostname='+hostname)).status,404);
  });
}
