import test from 'node:test';
import assert from 'node:assert/strict';
import { HostedSignIn } from '../src/modules/identity/hosted-sign-in.js';
import { BrowserSessions } from '../src/modules/identity/browser-sessions.js';
import { providerFixture } from './oidc-fixture.js';
const hub={id:'00000000-0000-4000-8000-000000000001',slug:'learn'};
async function fixture() {
  const provider=await providerFixture(),attempts=new Map(),rows=new Map();let resolves=0,time=Date.now();
  const store={storeLogin:async(k,v)=>attempts.set(k,v),consumeLogin:async(k,origin)=>{
    const v=attempts.get(k);if(!v||v.origin!==origin||v.expiresAt.getTime()<=time)return null;attempts.delete(k);return v;
  },store:async(k,v)=>rows.set(k,v),read:async k=>rows.get(k),delete:async k=>rows.delete(k)};
  const sessions=new BrowserSessions({store,originForHub:async id=>id===hub.id?'https://learn.example':null,now:()=>time});
  const signIn=new HostedSignIn({configuration:provider.configuration,store,sessions,now:()=>time,
    resolveUser:async(iss,sub)=>{assert.equal(iss,'https://identity.example');assert.equal(sub,'subject-a');resolves++;return hub.id;}});
  const req={headers:{host:'learn.example'}};
  const start=await signIn.begin(req,hub,'create-hub');
  const callbackReq={headers:{...req.headers,cookie:start.cookies[0].split(';')[0]}};
  return {provider,signIn,start,req:callbackReq,attempts,rows,sessions,get resolves(){return resolves;},expire:()=>{time+=601000;}};
}
test('hosted callback verifies real signed ID token and issues an opaque session without an Origin header',async()=>{
  const f=await fixture(),url=new URL(f.start.location);
  assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('scope'),'openid');
  const result=await f.signIn.complete(f.req,f.provider.authorize(f.start.location));
  assert.equal(result.location,'/h/learn/create-hub');assert.equal(f.resolves,1);assert.equal(f.rows.size,1);assert.equal(f.attempts.size,0);
  assert.match(result.cookies[0],/Max-Age=0/);assert.match(result.cookies[1],/Secure; HttpOnly/);
});
test('a consumed callback cannot be replayed or exchange a second code',async()=>{
  const f=await fixture(),url=f.provider.authorize(f.start.location);
  await f.signIn.complete(f.req,url);await assert.rejects(f.signIn.complete(f.req,url),{status:401});assert.equal(f.provider.calls,1);
});
test('missing mismatched and duplicate state/cookies fail before token exchange',async()=>{
  const f=await fixture(),url=f.provider.authorize(f.start.location);
  await assert.rejects(f.signIn.complete({headers:{host:'learn.example'}},url),{status:401});
  await assert.rejects(f.signIn.complete({headers:{...f.req.headers,cookie:'__Host-plinth-login='+ 'a'.repeat(64)}},url),{status:401});
  await assert.rejects(f.signIn.complete({headers:{...f.req.headers,cookie:f.req.headers.cookie+'; '+f.req.headers.cookie}},url),{status:401});
  url.searchParams.append('state',url.searchParams.get('state'));
  await assert.rejects(f.signIn.complete(f.req,url),{status:401});assert.equal(f.provider.calls,0);assert.equal(f.resolves,0);
});
test('wrong host and forwarded host cannot recover a login attempt',async()=>{
  const f=await fixture();await assert.rejects(f.signIn.complete({headers:{...f.req.headers,host:'evil.example','x-forwarded-host':'learn.example'}},f.provider.authorize(f.start.location)),{status:401});
  assert.equal(f.provider.calls,0);assert.equal(f.rows.size,0);
});
test('expired login attempts fail before token exchange',async()=>{
  const f=await fixture();f.expire();await assert.rejects(f.signIn.complete(f.req,f.provider.authorize(f.start.location)),{status:401});assert.equal(f.provider.calls,0);
});
for(const [name,options] of Object.entries({nonce:{overrides:{nonce:'wrong'}},audience:{overrides:{aud:'wrong'}},issuer:{overrides:{iss:'https://evil.example'}},expiry:{overrides:{exp:1}},signature:{forged:true},PKCE:{challenge:'wrong'}})) {
  test('invalid '+name+' rejects hosted sign-in without creating an account or session',async()=>{
    const f=await fixture();await assert.rejects(f.signIn.complete(f.req,f.provider.authorize(f.start.location,options)),{status:401});
    assert.equal(f.resolves,0);assert.equal(f.rows.size,0);assert.equal(f.attempts.size,0);
  });
}
test('arbitrary destinations and untrusted hosts cannot start login',async()=>{
  const f=await fixture();await assert.rejects(f.signIn.begin({headers:{host:'learn.example'}},hub,'https://evil.example'),{status:400});
  await assert.rejects(f.signIn.begin({headers:{host:'evil.example'}},hub),{status:401});
});
