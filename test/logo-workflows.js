import assert from 'node:assert/strict';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { HubRepository } from '../src/db/hub-repository.js';
import { collectLogos,logoGracePeriodMs } from '../src/modules/tenancy/logo-collector.js';
export async function logoChecks({admin,app,db,hubId,otherHub,userA,check,base,fetch,store,slug,embeddedMode}) {
  const url=base+'/v1/hubs/'+hubId+'/branding/logo';
  const bytes=await sharp({create:{width:800,height:400,channels:4,background:'blue'}}).png().toBuffer();
  const headers={authorization:'Bearer learner-a','content-type':'image/png'};
  let first,second,unpublished;
  await check('branding reader has only narrow function authority and runtime cannot assume its role',async()=>{
    assert.deepEqual((await admin.query("SELECT rolcanlogin,rolsuper,rolbypassrls FROM pg_roles WHERE rolname='plinth_branding_reader'")).rows[0],{rolcanlogin:false,rolsuper:false,rolbypassrls:false});
    assert.equal((await admin.query("SELECT pg_has_role('plinth_app','plinth_branding_reader','MEMBER') AS member")).rows[0].member,false);
    assert.equal((await admin.query("SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid='app.is_published_logo(uuid,text)'::regprocedure")).rows[0].owner,'plinth_branding_reader');
    if(!embeddedMode)await assert.rejects(app.query('SET ROLE plinth_branding_reader'),{code:'42501'});
    await db.withSnapshot({hubId:otherHub,userId:userA,orgIds:[],isStaff:false},async tx=>assert.equal((await tx.query('SELECT * FROM tenancy.hub_profiles WHERE hub_id=$1',[hubId])).rows.length,0));
  });
  await check('anonymous, other hub, non-member and suspended owner cannot upload',async()=>{
    assert.equal((await fetch(url,{method:'PUT',body:bytes})).status,401);
    assert.equal((await fetch(url,{method:'PUT',headers:{...headers,authorization:'Bearer learner-b'},body:bytes})).status,404);
    assert.equal((await fetch(base+'/v1/hubs/'+otherHub+'/branding/logo',{method:'PUT',headers,body:bytes})).status,404);
    await admin.query("UPDATE tenancy.memberships SET status='suspended' WHERE hub_id=$1 AND user_id=$2",[hubId,userA]);
    try{assert.equal((await fetch(url,{method:'PUT',headers,body:bytes})).status,404);}
    finally{await admin.query("UPDATE tenancy.memberships SET status='active' WHERE hub_id=$1 AND user_id=$2",[hubId,userA]);}
  });
  await check('owner uploads a normalised public logo and storefront references it',async()=>{
    const response=await fetch(url,{method:'PUT',headers,body:bytes});assert.equal(response.status,200);first=(await response.json()).logoPath;
    assert.match(first,new RegExp('^/assets/hubs/'+hubId+'/branding/[0-9a-f-]{36}\\.webp$'));
    const served=await fetch(base+first);assert.equal(served.status,200);assert.equal(served.headers.get('content-type'),'image/webp');assert.equal(served.headers.get('cache-control'),'no-store');
    const meta=await sharp(Buffer.from(await served.arrayBuffer())).metadata();assert.equal(meta.width,512);assert.equal(meta.height,256);
    assert.ok((await (await fetch(base+'/h/'+slug)).text()).includes(first));
  });
  await check('invalid upload leaves the existing logo unchanged',async()=>{
    for(const [body,type,expected] of [[Buffer.from('<svg/>'),'image/png',415],[bytes,'image/jpeg',415],[Buffer.from([137,80,78,71,13,10,26,10]),'image/png',400],[Buffer.alloc(2*1024*1024+1),'image/png',413]]) {
      assert.equal((await fetch(url,{method:'PUT',headers:{...headers,'content-type':type},body})).status,expected);
    }
    assert.equal((await fetch(base+first)).status,200);
  });
  await check('cookie uploads require CSRF and are hub-bound; admin form exposes the uploader',async()=>{
    const session=await fetch(base+'/v1/hubs/'+hubId+'/session',{method:'POST',headers:{authorization:'Bearer learner-a',host:'learn-new.example',origin:'https://learn-new.example'}});
    assert.equal(session.status,201);const cookie=session.headers.get('set-cookie').split(';')[0],csrf=(await session.json()).csrfToken;
    const browser={cookie,host:'learn-new.example',origin:'https://learn-new.example','content-type':'image/png'};
    assert.equal((await fetch(url,{method:'PUT',headers:browser,body:bytes})).status,403);
    assert.equal((await fetch(base+'/v1/hubs/'+otherHub+'/branding/logo',{method:'PUT',headers:{...browser,'x-csrf-token':csrf},body:bytes})).status,404);
    const page=await fetch(base+'/h/'+slug+'/admin',{headers:{cookie,host:'learn-new.example'}});assert.equal(page.status,200);assert.ok((await page.text()).includes('id="logo"'));
    const response=await fetch(url,{method:'PUT',headers:{...browser,'x-csrf-token':csrf},body:bytes});assert.equal(response.status,200);second=(await response.json()).logoPath;
  });
  await check('only the current pointer is public; replaced, removed and unpublished files return 404',async()=>{
    assert.equal((await fetch(base+first)).status,404);assert.equal((await fetch(base+second)).status,200);
    unpublished=randomUUID();await store.put(hubId,unpublished,await sharp(bytes).webp().toBuffer());
    assert.equal((await fetch(base+'/assets/hubs/'+hubId+'/branding/'+unpublished+'.webp')).status,404);
    assert.equal((await fetch(base+second.replace(hubId,otherHub))).status,404);
    assert.equal((await fetch(url,{method:'DELETE',headers:{authorization:'Bearer learner-a'}})).status,200);
    assert.equal((await fetch(base+second)).status,404);
  });
  await check('logo collector removes replaced, removed and unpublished objects but keeps current and in-flight logos',async()=>{
    const current=(await (await fetch(url,{method:'PUT',headers,body:bytes})).json()).logoPath,key=path=>path.split('/').pop().slice(0,-'.webp'.length);
    const inflight=randomUUID();await store.put(hubId,inflight,await sharp(bytes).webp().toBuffer());
    // Age everything except the in-flight upload past the grace period.
    const aged={hubs:()=>store.hubs(),delete:(h,id)=>store.delete(h,id),
      list:async h=>(await store.list(h)).map(o=>o.id===inflight?o:{...o,modifiedAt:new Date(o.modifiedAt.getTime()-2*logoGracePeriodMs)})};
    const hubs=new HubRepository(db),isPublishedLogo=(h,file)=>hubs.isPublishedLogo(h,file);
    const stale=[key(first),key(second),unpublished].sort();
    const dry=await collectLogos({store:aged,isPublishedLogo});
    assert.deepEqual(dry.removed.filter(r=>r.hubId===hubId).map(r=>r.id).sort(),stale);assert.equal(dry.recent,1);
    for(const id of stale)assert.ok(await store.read(hubId,id));
    await collectLogos({store:aged,isPublishedLogo,apply:true});
    for(const id of stale)assert.equal(await store.read(hubId,id),null);
    assert.ok(await store.read(hubId,inflight));assert.ok(await store.read(hubId,key(current)));
    assert.equal((await fetch(base+current)).status,200);
    assert.deepEqual((await store.list(hubId)).map(o=>o.id).sort(),[inflight,key(current)].sort());
  });
}
