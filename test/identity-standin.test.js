import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { TestIdentityProvider } from '../src/dev/test-identity-provider.js';
import { HostedSignIn } from '../src/modules/identity/hosted-sign-in.js';
import { BrowserSessions } from '../src/modules/identity/browser-sessions.js';
const origin='https://localhost:8443',hub={id:'00000000-0000-4000-8000-000000000001',slug:'zoya-speaks'};
const people=[{subject:'zoya',name:'Zoya'}];
function response() {
  const res={status:null,headers:{},body:'',writeHead(status,headers={}){res.status=status;res.headers=headers;},end(body=''){res.body=body;}};
  return res;
}
const post=(body)=>Object.assign(Readable.from([body]),{method:'POST',headers:{}});
async function fixture() {
  const idp=await TestIdentityProvider.create({issuer:origin+'/test-auth',clientId:'plinth-local',redirectUri:origin+'/auth/callback',people,environment:'test'});
  const attempts=new Map(),rows=new Map(),resolved=[];
  const store={storeLogin:async(k,v)=>attempts.set(k,v),consumeLogin:async(k,o)=>{const v=attempts.get(k);attempts.delete(k);return v?.origin===o?v:null;},
    store:async(k,v)=>rows.set(k,{...v,createdAt:new Date()}),read:async k=>rows.get(k),delete:async k=>rows.delete(k)};
  const sessions=new BrowserSessions({store,originForHub:async()=>origin});
  const signIn=new HostedSignIn({configuration:idp.configuration(),store,sessions,resolveUser:async(iss,sub)=>{resolved.push([iss,sub]);return '00000000-0000-4000-8000-0000000000aa';}});
  return {idp,signIn,resolved,rows};
}
test('the test identity provider refuses to run in production',async()=>{
  await assert.rejects(TestIdentityProvider.create({issuer:origin+'/test-auth',clientId:'x',redirectUri:origin+'/auth/callback',people,environment:'production'}),/production/);
});
test('choosing a person completes the real hosted sign-in flow with a signed ID token',async()=>{
  const f=await fixture(),req={headers:{host:'localhost:8443'}};
  const start=await f.signIn.begin(req,hub,'member'),authorize=new URL(start.location);
  const page=response();await f.idp.handle({method:'GET',headers:{}},page,authorize);
  assert.equal(page.status,200);assert.match(page.body,/TEST SIGN-IN \(local only\)/);assert.match(page.body,/Zoya/);
  const form=new URLSearchParams(authorize.searchParams);form.set('subject','zoya');
  const chosen=response();await f.idp.handle(post(form.toString()),chosen,new URL(authorize.pathname,origin));
  assert.equal(chosen.status,303);
  const callbackReq={headers:{host:'localhost:8443',cookie:start.cookies[0].split(';')[0]}};
  const done=await f.signIn.complete(callbackReq,new URL(chosen.headers.location));
  assert.equal(done.location,'/h/zoya-speaks/member');assert.deepEqual(f.resolved,[[origin+'/test-auth','zoya']]);assert.equal(f.rows.size,1);
  // The one-use code cannot be redeemed twice.
  await assert.rejects(f.signIn.complete(callbackReq,new URL(chosen.headers.location)),{status:401});
});
test('the sign-in page rejects foreign redirects, missing PKCE and unknown people',async()=>{
  const f=await fixture(),start=await f.signIn.begin({headers:{host:'localhost:8443'}},hub,'member'),authorize=new URL(start.location);
  for(const [key,value] of [['redirect_uri','https://evil.example/auth/callback'],['client_id','other'],['code_challenge_method','plain']]) {
    const tampered=new URL(authorize);tampered.searchParams.set(key,value);
    const res=response();await f.idp.handle({method:'GET',headers:{}},res,tampered);assert.equal(res.status,400,key);
  }
  const form=new URLSearchParams(authorize.searchParams);form.set('subject','not-a-person');
  const res=response();await f.idp.handle(post(form.toString()),res,new URL(authorize.pathname,origin));assert.equal(res.status,400);
});
