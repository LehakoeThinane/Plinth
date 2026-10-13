import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DomainVerification,domainDigest,domainHostname } from '../src/modules/tenancy/domain-verification.js';
import { OrganisationDomains } from '../src/modules/identity/organisation-domains.js';
test('hostnames are canonical and reject paths, ports, IPs, private names and oversized DNS labels',()=>{
  assert.equal(domainHostname('Learn.Company.CO.ZA'),'learn.company.co.za');
  for(const host of ['https://learn.company.com','a.com/path','a.com:443','127.0.0.1','localhost','a.local','a.internal','a.test',' a.com','a.com.','a'.repeat(64)+'.com','a.'.repeat(120)+'com','<script>.com'])assert.throws(()=>domainHostname(host),{status:400});
});
test('DNS TXT chunks in one record join but separate records never join',async()=>{
  const value='plinth-domain='+'a'.repeat(64);let confirmed=0;
  const repository={challenge:async()=>({challenge_hash:domainDigest(value)}),confirm:async()=>{confirmed++;return {ok:true};}};
  const service=new DomainVerification({repository,resolveTxt:async name=>{assert.equal(name,'_plinth-verification.learn.company.com');return [[value.slice(0,20),value.slice(20)]];}});
  assert.deepEqual(await service.verify('hub',{hostname:'learn.company.com'}),{ok:true});assert.equal(confirmed,1);
  const split=new DomainVerification({repository,resolveTxt:async()=>[[value.slice(0,20)],[value.slice(20)]]});
  await assert.rejects(split.verify('hub',{hostname:'learn.company.com'}),{status:409});assert.equal(confirmed,1);
});
test('missing wrong malformed and failed DNS proofs cannot publish',async()=>{
  const value='plinth-domain='+'b'.repeat(64),repository={challenge:async()=>({challenge_hash:domainDigest(value)}),confirm:async()=>assert.fail('Unexpected publication')};
  for(const records of [[],[['plinth-domain='+'c'.repeat(64)]],[[value+'extra']],[[null]],null])await assert.rejects(new DomainVerification({repository,resolveTxt:async()=>records}).verify('hub',{hostname:'learn.company.com'}),{status:409});
  for(const code of ['ENODATA','ENOTFOUND','ETIMEOUT'])await assert.rejects(new DomainVerification({repository,resolveTxt:async()=>{throw Object.assign(new Error('DNS'),{code});}}).verify('hub',{hostname:'learn.company.com'}),{status:409});
});
test('organisation proofs need their own prefix, a valid organisation and the exact challenge',async()=>{
  const org='00000000-0000-4000-8000-000000000001',hub='00000000-0000-4000-8000-000000000002';
  const orgValue='plinth-organisation='+'e'.repeat(64),hubValue='plinth-domain='+'e'.repeat(64);let confirmed=0;
  const repository={challenge:async()=>domainDigest(orgValue),confirm:async(h,o,domain,hash)=>{confirmed++;assert.equal(hash,domainDigest(orgValue));return {domain};}};
  const withRecords=records=>new OrganisationDomains({repository,resolveTxt:async name=>{assert.equal(name,'_plinth-verification.company.co.za');return records;}});
  // A hub-domain proof with the same hash input cannot stand in for an organisation proof.
  const hubRepository={...repository,challenge:async()=>domainDigest(hubValue)};
  await assert.rejects(new OrganisationDomains({repository:hubRepository,resolveTxt:async()=>[[hubValue]]}).verify(hub,org,{domain:'company.co.za'}),{status:409});
  await assert.rejects(withRecords([['plinth-organisation='+'f'.repeat(64)]]).verify(hub,org,{domain:'company.co.za'}),{status:409});
  await assert.rejects(withRecords([[orgValue]]).verify(hub,'not-an-org',{domain:'company.co.za'}),{status:400});
  await assert.rejects(withRecords([[orgValue]]).verify(hub,org,{domain:'https://company.co.za'}),{status:400});
  assert.equal(confirmed,0);
  assert.deepEqual(await withRecords([[orgValue.slice(0,30),orgValue.slice(30)]]).verify(hub,org,{domain:'Company.CO.ZA'}),{domain:'company.co.za'});
  assert.equal(confirmed,1);
});
test('unavailable admin authority fails before DNS and publication errors propagate',async()=>{
  await assert.rejects(new DomainVerification({repository:{challenge:async()=>{throw Object.assign(new Error('Denied'),{status:404});}},resolveTxt:async()=>assert.fail('Unexpected DNS')}).verify('hub',{hostname:'learn.company.com'}),{status:404});
  const value='plinth-domain='+'d'.repeat(64);
  await assert.rejects(new DomainVerification({repository:{challenge:async()=>({challenge_hash:domainDigest(value)}),confirm:async()=>{throw Object.assign(new Error('Rotated'),{status:409});}},resolveTxt:async()=>[[value]]}).verify('hub',{hostname:'learn.company.com'}),{status:409});
});
