import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair,exportJWK,createLocalJWKSet,SignJWT } from 'jose';
import { createManagedAuthenticator } from '../src/modules/identity/managed-auth.js';
import { BrowserSessions } from '../src/modules/identity/browser-sessions.js';
const issuer='https://identity.example',audience='plinth-api';
const {privateKey,publicKey}=await generateKeyPair('ES256');
const jwk=await exportJWK(publicKey);jwk.kid='test';
const keys=createLocalJWKSet({keys:[jwk]});
const now=Math.floor(Date.now()/1000);
async function token(overrides={},typ='at+jwt',key=privateKey) {
  return new SignJWT({iss:issuer,aud:audience,sub:'subject-a',iat:now,exp:now+600,...overrides})
    .setProtectedHeader({alg:'ES256',kid:'test',typ}).sign(key);
}
function authenticator(extra={}) {
  let calls=0;
  const verify=createManagedAuthenticator({issuer,audience,keySet:keys,algorithms:['ES256'],
    resolveUser:async()=>{calls++;return '00000000-0000-4000-8000-000000000001';},...extra});
  return {verify,get calls(){return calls;}};
}
test('verified token resolves the server account and ignores user/role claims',async()=>{
  const auth=authenticator(),result=await auth.verify(await token({userId:'attacker',role:'owner'}));
  assert.equal(result.userId,'00000000-0000-4000-8000-000000000001');assert.equal(auth.calls,1);
});
test('wrong issuer or audience cannot reach account provisioning',async()=>{
  const auth=authenticator();
  for(const claims of [{iss:'https://evil.example'},{aud:'another-api'}])assert.equal(await auth.verify(await token(claims)),null);
  assert.equal(auth.calls,0);
});
test('forged signature and unexpected token type are rejected',async()=>{
  const auth=authenticator(),other=await generateKeyPair('ES256');
  assert.equal(await auth.verify(await token({},'at+jwt',other.privateKey)),null);
  assert.equal(await auth.verify(await token({},'JWT')),null);assert.equal(auth.calls,0);
});
test('expiry issued-at and subject are mandatory and malformed tokens are rejected',async()=>{
  const auth=authenticator();
  for(const claims of [{exp:now-1},{exp:undefined},{iat:undefined},{iat:now+600},{iat:now-7200},{sub:''}])assert.equal(await auth.verify(await token(claims)),null);
  assert.equal(await auth.verify('not-a-token'),null);assert.equal(auth.calls,0);
});
test('provider claim checks can require access-token use and disabled identity is rejected',async()=>{
  const auth=authenticator({tokenType:'JWT',claimChecks:p=>p.token_use==='access'});
  assert.equal(await auth.verify(await token({token_use:'id'},'JWT')),null);
  assert.ok(await auth.verify(await token({token_use:'access'},'JWT')));
  assert.equal(await authenticator({resolveUser:async()=>null}).verify(await token()),null);
});
test('insecure endpoints and symmetric algorithm configuration are rejected',()=>{
  assert.throws(()=>authenticator({issuer:'http://identity.example'}),/HTTPS/);
  assert.throws(()=>authenticator({algorithms:['HS256']}),/configuration/);
});

function sessionsFixture() {
  const rows=new Map(),hubId='00000000-0000-4000-8000-000000000002';let time=Date.now();
  const store={store:async(k,v)=>rows.set(k,v),read:async k=>rows.get(k),delete:async k=>rows.delete(k)};
  const sessions=new BrowserSessions({store,originForHub:async id=>id===hubId?'https://learn.example':null,now:()=>time});
  const req={headers:{host:'learn.example',origin:'https://learn.example'}};
  return {sessions,rows,hubId,req,expire:()=>{time+=2*60*60*1000;},identity:{userId:'00000000-0000-4000-8000-000000000001',expiresAt:new Date(time+60*60*1000)}};
}
test('session cookie is host-only secure HttpOnly and only its hash is stored',async()=>{
  const f=sessionsFixture(),result=await f.sessions.establish(f.req,f.hubId,f.identity);
  assert.match(result.cookie,/^__Host-plinth-session=/);assert.match(result.cookie,/Secure; HttpOnly; SameSite=Lax/);
  assert.ok(!result.cookie.includes('Domain='));
  const value=result.cookie.split(';')[0].split('=')[1];assert.ok(!f.rows.has(value));
  assert.equal(f.rows.size,1);
});
test('wrong host/origin and forwarded host cannot establish or recover a session',async()=>{
  const f=sessionsFixture();
  await assert.rejects(f.sessions.establish({headers:{host:'learn.example',origin:'https://evil.example'}},f.hubId,f.identity),{status:403});
  const session=await f.sessions.establish(f.req,f.hubId,f.identity),cookie=session.cookie.split(';')[0];
  assert.equal(await f.sessions.principal({headers:{host:'evil.example',cookie,'x-forwarded-host':'learn.example'}}),null);
});
test('CSRF and origin checks protect mutation and logout revokes server state',async()=>{
  const f=sessionsFixture(),session=await f.sessions.establish(f.req,f.hubId,f.identity);
  const req={headers:{...f.req.headers,cookie:session.cookie.split(';')[0]}};
  const principal=await f.sessions.principal(req);
  assert.throws(()=>f.sessions.checkMutation(req,principal),{status:403});
  req.headers['x-csrf-token']=session.csrfToken;
  f.sessions.checkMutation(req,principal);await f.sessions.end(req,principal);
  assert.equal(await f.sessions.principal(req),null);
});
test('expired duplicate and replaced cookies cannot authenticate',async()=>{
  const f=sessionsFixture(),first=await f.sessions.establish(f.req,f.hubId,f.identity),cookie=first.cookie.split(';')[0];
  assert.equal(await f.sessions.principal({headers:{host:'learn.example',cookie:cookie+'; '+cookie}}),null);
  const req={headers:{...f.req.headers,cookie}};
  const second=await f.sessions.establish(req,f.hubId,f.identity);
  assert.equal(await f.sessions.principal(req),null);
  f.expire();assert.equal(await f.sessions.principal({headers:{host:'learn.example',cookie:second.cookie.split(';')[0]}}),null);
});
