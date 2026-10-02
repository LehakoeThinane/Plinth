import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApi } from '../src/http/server.js';
const hub='00000000-0000-4000-8000-000000000001';
const lesson='00000000-0000-4000-8000-000000000002';
const user='00000000-0000-4000-8000-000000000003';
async function fixture(fn){
 let observed;const server=createApi({authenticate:async token=>token==='valid'?{userId:user}:null,accessForPrincipal:p=>({check:async req=>{observed={p,req};return fn(req);}})});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const url='http://127.0.0.1:'+server.address().port+'/v1/hubs/'+hub+'/lessons/'+lesson+'/access';
 return {url,get observed(){return observed;},close:()=>new Promise(r=>server.close(r))};
}
test('anonymous request rejected',async()=>{const f=await fixture(()=>({decision:'allowed'}));try{assert.equal((await fetch(f.url)).status,401);}finally{await f.close();}});
test('invalid bearer rejected',async()=>{const f=await fixture(()=>({decision:'allowed'}));try{assert.equal((await fetch(f.url,{headers:{authorization:'Bearer invalid'}})).status,401);}finally{await f.close();}});
test('hidden resource becomes HTTP 404 without preview',async()=>{const f=await fixture(()=>({decision:'not_found'}));try{const r=await fetch(f.url,{headers:{authorization:'Bearer valid'}});assert.equal(r.status,404);assert.deepEqual(await r.json(),{error:'not_found'});}finally{await f.close();}});
test('client identity/role headers cannot override verified principal',async()=>{const f=await fixture(()=>({decision:'allowed'}));try{const r=await fetch(f.url+'?userId=attacker',{headers:{authorization:'Bearer valid','x-user-id':'attacker','x-is-staff':'true','x-org-ids':'other'}});assert.equal(r.status,200);assert.deepEqual(f.observed.req,{hubId:hub,targetId:lesson,userId:user});assert.equal(r.headers.get('cache-control'),'no-store');}finally{await f.close();}});
test('legitimate locked response preserved',async()=>{const f=await fixture(()=>({decision:'locked',reason:'purchase'}));try{const r=await fetch(f.url,{headers:{authorization:'Bearer valid'}});assert.equal(r.status,200);assert.equal((await r.json()).decision,'locked');}finally{await f.close();}});
test('unexpected error hides implementation details',async()=>{const f=await fixture(()=>{throw Error('secret');});try{const r=await fetch(f.url,{headers:{authorization:'Bearer valid'}});assert.equal(r.status,500);assert.deepEqual(await r.json(),{error:'internal_error'});}finally{await f.close();}});
