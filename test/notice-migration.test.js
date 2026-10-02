import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile,readdir } from 'node:fs/promises';
test('publication migration reserves historical consent versions and preserves unknown metadata',async()=>{
  const engine=await PGlite.create();
  try {
    const migrations=(await readdir(new URL('../db/migrations/',import.meta.url))).filter(n=>/^00\d.*\.sql$/.test(n)).sort();
    for(const path of ['../db/local-init.sql',...migrations.map(n=>'../db/migrations/'+n)])await engine.exec(await readFile(new URL(path,import.meta.url),'utf8'));
    const hub='00000000-0000-4000-8000-000000000001',user='00000000-0000-4000-8000-000000000002';
    await engine.query("INSERT INTO tenancy.hubs(id,slug) VALUES($1,'legacy-hub')",[hub]);
    await engine.query('INSERT INTO identity.users(id) VALUES($1)',[user]);
    await engine.query("INSERT INTO compliance.consent_purposes(hub_id,purpose,notice_version,notice_text) VALUES($1,'marketing','v1','Old wording')",[hub]);
    await engine.query("INSERT INTO compliance.consents(hub_id,user_id,purpose,granted,notice_version) VALUES($1,$2,'marketing',true,'v1')",[hub,user]);
    await engine.query("UPDATE compliance.consent_purposes SET notice_version='v2',notice_text='Current wording' WHERE hub_id=$1",[hub]);
    await engine.exec(await readFile(new URL('../db/migrations/010-purpose-publication.sql',import.meta.url),'utf8'));
    const history=(await engine.query('SELECT notice_version,notice_text,published_by,published_at FROM compliance.notice_publications ORDER BY notice_version')).rows;
    assert.deepEqual(history,[{notice_version:'v1',notice_text:'Old wording',published_by:null,published_at:null},{notice_version:'v2',notice_text:'Current wording',published_by:null,published_at:null}]);
    await assert.rejects(engine.query("UPDATE compliance.consent_purposes SET notice_version='v1',notice_text='Old wording' WHERE hub_id=$1",[hub]),{code:'23505'});
    assert.equal((await engine.query('SELECT notice_version FROM compliance.consent_purposes')).rows[0].notice_version,'v2');
  }finally{await engine.close();}
});
