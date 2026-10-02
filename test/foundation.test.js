import assert from 'node:assert/strict';
import { AccessService } from '../src/access.js';
import { mergeProgress } from '../src/progress.js';

export async function runTests() {
  let passed = 0;
  async function test(name, fn) { await fn(); passed++; }
  function fixture() {
    const rows = [
      { id: 'lesson', hubId: 'h', status: 'published', access: 'members', visibility: 'members', previewAvailable: false },
      { id: 'product', hubId: 'h', status: 'published', access: 'entitled', visibility: 'public' }
    ];
    const summary = { membership: {status: 'active', role: 'member'}, orgIds: ['company'], entitlements: [], tierBenefits: {} };
    const versions = {userVersion: 1, hubEpoch: 1};
    const conversation = {hubId: 'h', participantIds: ['u'], companyOrg: 'company'};
    const cacheEntries = new Map();
    const cache = {get: async k => cacheEntries.get(k), set: async (k,v) => cacheEntries.set(k,structuredClone(v))};
    const snapshot = { getTargetChain: async () => structuredClone(rows), getVersions: async () => ({...versions}),
      getAccessSummary: async () => structuredClone(summary), getConversation: async () => structuredClone(conversation) };
    const repository = {withSnapshot: async (hubId, fn) => fn(snapshot)};
    const service = new AccessService(repository, cache, () => 1000);
    return {rows,summary,versions,conversation,cache,service};
  }
  const request = {hubId:'h',userId:'u',targetId:'lesson'};
  await test('child membership does not bypass paid parent', async () => {
    assert.equal((await fixture().service.check(request)).decision,'not_found');
  });
  await test('parent entitlement grants lesson', async () => {
    const f=fixture(); f.summary.entitlements.push({targetId:'product'});
    assert.equal((await f.service.check(request)).decision,'allowed');
  });
  await test('cross-hub child fails closed', async () => {
    const f=fixture(); f.rows[0].hubId='other';
    assert.equal((await f.service.check(request)).decision,'not_found');
  });
  await test('company boundary is inherited even by open child', async () => {
    const f=fixture(); f.rows[0].access='open'; f.rows[1].companyOrg='other';
    assert.equal((await f.service.check(request)).decision,'not_found');
  });
  await test('anonymous public listing grants metadata only', async () => {
    const f=fixture(); f.rows.shift();
    assert.deepEqual(await f.service.check({...request,userId:null,operation:'listing'}),{decision:'allowed',metadataOnly:true});
    assert.equal((await f.service.check({...request,userId:null})).decision,'not_found');
  });
  await test('revocation is effective despite stale cache', async () => {
    const f=fixture(); f.summary.entitlements.push({targetId:'product'});
    assert.equal((await f.service.check(request)).decision,'allowed');
    f.summary.entitlements=[]; f.versions.userVersion++;
    assert.equal((await f.service.check(request)).decision,'not_found');
  });
  await test('hub epoch detects removed tier benefit', async () => {
    const f=fixture(); f.summary.entitlements.push({targetId:'tier',kind:'tier'}); f.summary.tierBenefits.tier=['product'];
    assert.equal((await f.service.check(request)).decision,'allowed');
    f.summary.tierBenefits.tier=[]; f.versions.hubEpoch++;
    assert.equal((await f.service.check(request)).decision,'not_found');
  });
  await test('expired entitlement denied even in matching cache', async () => {
    const f=fixture(); f.summary.entitlements.push({targetId:'product',expiresAt:999});
    assert.equal((await f.service.check(request)).decision,'not_found');
  });
  await test('cache failure falls back to authoritative data', async () => {
    const f=fixture(); f.summary.entitlements.push({targetId:'product'});
    f.cache.get=async()=>{throw Error('Redis unavailable');}; f.cache.set=f.cache.get;
    assert.equal((await f.service.check(request)).decision,'allowed');
  });
  await test('delivery catches suspension without participation change', async () => {
    const f=fixture(); const req={hubId:'h',conversationId:'c',candidateUserIds:['u']};
    assert.deepEqual(await f.service.recipients(req),['u']);
    f.summary.membership.status='suspended'; f.versions.userVersion++;
    assert.deepEqual(await f.service.recipients(req),[]);
  });
  await test('delivery catches company removal without participation change', async () => {
    const f=fixture(); const req={hubId:'h',conversationId:'c',candidateUserIds:['u']};
    assert.deepEqual(await f.service.recipients(req),['u']);
    f.summary.orgIds=[]; f.versions.userVersion++;
    assert.deepEqual(await f.service.recipients(req),[]);
  });
  await test('removed conversation participant cannot receive', async () => {
    const f=fixture(); f.conversation.participantIds=[];
    assert.deepEqual(await f.service.recipients({hubId:'h',conversationId:'c',candidateUserIds:['u']}),[]);
  });
  const current={revision:4,furthestPosition:500,resumePosition:450,completed:false};
  await test('rewind updates resume while preserving furthest position', async () => {
    const result=mergeProgress(current,{baseRevision:4,furthestPosition:100,resumePosition:100,completed:false});
    assert.equal(result.state.resumePosition,100); assert.equal(result.state.furthestPosition,500);
    assert.equal(result.resumeConflict,false);
  });
  await test('stale offline progress cannot overwrite newer resume', async () => {
    const result=mergeProgress(current,{baseRevision:2,furthestPosition:100,resumePosition:100,completed:false});
    assert.equal(result.state.resumePosition,450); assert.equal(result.resumeConflict,true);
  });
  await test('stale update can retain additional completion evidence', async () => {
    const result=mergeProgress(current,{baseRevision:2,furthestPosition:600,resumePosition:600,completed:true});
    assert.equal(result.state.furthestPosition,600); assert.equal(result.state.completed,true);
    assert.equal(result.state.resumePosition,450);
  });
  await test('invalid progress rejected', async () => {
    assert.throws(()=>mergeProgress(current,{baseRevision:4,furthestPosition:-1,resumePosition:0,completed:false}));
  });
  return {passed};
}
console.log(await runTests());
