import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { mkdir,mkdtemp,rm } from 'node:fs/promises';
import { resolve,relative,isAbsolute } from 'node:path';
import { normaliseLogo,maxLogoBytes } from '../src/modules/tenancy/logo-images.js';
import { LocalBrandingStore } from '../src/storage/local-branding.js';
import { LogoService } from '../src/modules/tenancy/logo-service.js';
import { collectLogos,logoGracePeriodMs } from '../src/modules/tenancy/logo-collector.js';
import { writeFile,utimes } from 'node:fs/promises';
const image=()=>sharp({create:{width:800,height:400,channels:4,background:'#2456a6'}});
test('PNG, JPEG and WebP become bounded static WebP without metadata',async()=>{
  for(const [format,type] of [['png','image/png'],['jpeg','image/jpeg'],['webp','image/webp']]) {
    const source=await image()[format]().withMetadata().toBuffer();
    const output=await normaliseLogo(source,type),meta=await sharp(output).metadata();
    assert.equal(meta.format,'webp');assert.equal(meta.width,512);assert.equal(meta.height,256);
    assert.equal(meta.exif,undefined);assert.equal(meta.icc,undefined);assert.ok(output.length<=512*1024);
  }
});
test('SVG, HTML and mismatched MIME never reach a supported image upload',async()=>{
  for(const input of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),Buffer.from('<html>')])await assert.rejects(normaliseLogo(input,'image/png'),{status:415});
  await assert.rejects(normaliseLogo(await image().png().toBuffer(),'image/jpeg'),{status:415});
});
test('corrupt, empty and oversized inputs fail predictably',async()=>{
  await assert.rejects(normaliseLogo(Buffer.from([137,80,78,71,13,10,26,10]),'image/png'),{status:400});
  await assert.rejects(normaliseLogo(Buffer.alloc(0),'image/png'),{status:400});
  await assert.rejects(normaliseLogo(Buffer.alloc(maxLogoBytes+1),'image/png'),{status:413});
});
test('excessive decoded pixels and animation are rejected',async()=>{
  const huge=await sharp({create:{width:2100,height:2100,channels:3,background:'red'}}).png().toBuffer();
  await assert.rejects(normaliseLogo(huge,'image/png'),{status:400});
  const gif=Buffer.from('47494638396101000100800000000000ffffff21f904000a0000002c000000000100010000020244010021f904000a0000002c00000000010001000002024c01003b','hex');
  const animated=await sharp(gif,{animated:true}).webp().toBuffer();
  assert.equal((await sharp(animated).metadata()).pages,2);
  await assert.rejects(normaliseLogo(animated,'image/webp'),{status:400});
  const png=await image().png().toBuffer();
  // An APNG control chunk is disallowed before decoder interpretation/CRC checks.
  const control=Buffer.alloc(20);control.writeUInt32BE(8);control.write('acTL',4);control.writeUInt32BE(2,8);
  await assert.rejects(normaliseLogo(Buffer.concat([png.subarray(0,33),control,png.subarray(33)]),'image/png'),{status:400});

});
test('private storage persists across instances and rejects traversal and overwrites',async()=>{
  const root=resolve('.local'),hub=randomUUID(),id=randomUUID();await mkdir(root,{recursive:true});
  const directory=await mkdtemp(resolve(root,'logo-unit-'));
  try {
    const store=new LocalBrandingStore({root:directory}),bytes=await normaliseLogo(await image().png().toBuffer(),'image/png');
    await store.put(hub,id,bytes);
    assert.deepEqual(await new LocalBrandingStore({root:directory}).read(hub,id),bytes);
    await assert.rejects(store.put(hub,id,bytes),{code:'EEXIST'});
    await assert.rejects(store.read(hub,'../secret'),/Invalid/);
    await assert.rejects(store.put('../escape',id,bytes),/Invalid/);
    await store.delete(hub,id);assert.equal(await store.read(hub,id),null);
  }finally{const path=relative(root,directory);assert.ok(path&&!path.startsWith('..')&&!isAbsolute(path));await rm(directory,{recursive:true,force:true});}
});
test('authority loss at publication removes the unpublished object; learners cannot write',async()=>{
  const hub=randomUUID(),bytes=await image().png().toBuffer(),objects=new Map();
  const store={put:async(h,id,data)=>objects.set(id,data),delete:async(h,id)=>objects.delete(id)};
  const error=Object.assign(new Error('Revoked'),{status:404});
  const service=new LogoService({store,hubs:{membership:async()=>({role:'owner'}),brand:async()=>{throw error;}}});
  await assert.rejects(service.upload(hub,bytes,'image/png'),e=>e===error);assert.equal(objects.size,0);
  const learner=new LogoService({store,hubs:{membership:async()=>({role:'member'})}});
  await assert.rejects(learner.upload(hub,bytes,'image/png'),{status:404});assert.equal(objects.size,0);
});
test('collector keeps current and recent logos, removes only old unpublished ones and dry-runs by default',async()=>{
  const now=Date.now(),old=new Date(now-logoGracePeriodMs-1000),fresh=new Date(now-1000),hub=randomUUID(),other=randomUUID();
  const ids={current:randomUUID(),replaced:randomUUID(),inflight:randomUUID(),foreign:randomUUID()};
  const objects=new Map([[hub,[{id:ids.current,modifiedAt:old},{id:ids.replaced,modifiedAt:old},{id:ids.inflight,modifiedAt:fresh}]],[other,[{id:ids.foreign,modifiedAt:old}]]]);
  const deleted=[],store={hubs:async()=>[...objects.keys()],list:async h=>objects.get(h),delete:async(h,id)=>deleted.push(id)};
  // Only the exact hub/key pair counts: a key current in one hub is not current in another.
  const isPublishedLogo=async(h,file)=>h===hub&&file===ids.current+'.webp';
  const dry=await collectLogos({store,isPublishedLogo,now});
  assert.deepEqual({dryRun:dry.dryRun,kept:dry.kept,recent:dry.recent},{dryRun:true,kept:1,recent:1});
  assert.deepEqual(dry.removed.map(r=>r.id).sort(),[ids.replaced,ids.foreign].sort());assert.equal(deleted.length,0);
  const applied=await collectLogos({store,isPublishedLogo,now,apply:true});
  assert.equal(applied.dryRun,false);assert.deepEqual(deleted.sort(),[ids.replaced,ids.foreign].sort());
  for(const graceMs of [0,59999,NaN])await assert.rejects(collectLogos({store,isPublishedLogo,graceMs}),/Grace period/);
});
test('private storage lists only valid logo objects for the collector',async()=>{
  const root=resolve('.local'),hub=randomUUID(),id=randomUUID();await mkdir(root,{recursive:true});
  const directory=await mkdtemp(resolve(root,'logo-list-'));
  try {
    const store=new LocalBrandingStore({root:directory});
    assert.deepEqual(await store.hubs(),[]);
    await store.put(hub,id,await normaliseLogo(await image().png().toBuffer(),'image/png'));
    const folder=resolve(directory,'hubs',hub,'branding');
    await writeFile(resolve(folder,'notes.txt'),'ignored');await writeFile(resolve(folder,'not-a-uuid.webp'),'ignored');
    await mkdir(resolve(directory,'hubs','not-a-hub'),{recursive:true});
    const past=new Date(Date.now()-7200000);await utimes(resolve(folder,id+'.webp'),past,past);
    assert.deepEqual(await store.hubs(),[hub]);
    const listed=await store.list(hub);assert.deepEqual(listed.map(o=>o.id),[id]);assert.ok(Math.abs(listed[0].modifiedAt-past)<2000);
    await assert.rejects(store.list('../escape'),/Invalid/);assert.deepEqual(await store.list(randomUUID()),[]);
  }finally{const path=relative(root,directory);assert.ok(path&&!path.startsWith('..')&&!isAbsolute(path));await rm(directory,{recursive:true,force:true});}
});