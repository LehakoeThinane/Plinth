import { PGlite } from '@electric-sql/pglite';
import { readFile,readdir } from 'node:fs/promises';
/** Test-only single-session adapter. It runs actual PostgreSQL SQL/RLS, but
 * cannot validate independent connection concurrency or network protocol.
 */
export async function createEmbeddedPools() {
  const engine=await PGlite.create();
  const migrations=(await readdir(new URL('../db/migrations/',import.meta.url))).filter(name=>/^\d+.*\.sql$/.test(name)).sort();
  for(const path of ['../db/local-init.sql',...migrations.map(name=>'../db/migrations/'+name)]) {
    await engine.exec(await readFile(new URL(path,import.meta.url),'utf8'));
  }
  let queue=Promise.resolve();
  function pool(role) {
    return {
      async connect() {
        let unlock;const previous=queue;queue=new Promise(resolve=>{unlock=resolve;});await previous;
        try{await engine.exec(role==='admin'?'RESET ROLE':'SET ROLE '+role);}catch(error){unlock();throw error;}
        let released=false;
        return {
          async query(sql,params) {if(released)throw Error('Released client');return engine.query(sql,params);},
          release() {if(released)return;released=true;unlock();}
        };
      },
      async query(sql,params) {const client=await this.connect();try{return await client.query(sql,params);}finally{client.release();}},
      async end() {}
    };
  }
  return {admin:pool('admin'),app:pool('plinth_app'),auth:pool('plinth_auth'),domains:pool('plinth_domain_verifier'),close:()=>engine.close()};
}
