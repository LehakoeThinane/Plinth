import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir,readFile } from 'node:fs/promises';
import { modules } from '../src/modules/index.js';
async function files(url){const out=[];for(const e of await readdir(url,{withFileTypes:true})){const child=new URL(e.name+(e.isDirectory()?'/':''),url);if(e.isDirectory())out.push(...await files(child));else if(e.name.endsWith('.js'))out.push(child);}return out;}
test('module folders match registered ownership map',async()=>{
 const entries=await readdir(new URL('../src/modules/',import.meta.url),{withFileTypes:true});
 assert.deepEqual(entries.filter(e=>e.isDirectory()).map(e=>e.name).sort(),Object.keys(modules).sort());
 for(const name of Object.keys(modules)){const m=await import('../src/modules/'+name+'/index.js');assert.equal(m.moduleName,name);}
});
test('database drivers are restricted to infrastructure adapters',async()=>{
 for(const file of await files(new URL('../src/',import.meta.url))){const text=await readFile(file,'utf8');if(!file.pathname.includes('/src/db/'))assert.doesNotMatch(text,/(?:from|import\s*\()\s*['"](?:pg|postgres|@electric-sql\/pglite)['"]/);}
});
