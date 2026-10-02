import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
/** Test-only single-session adapter. It runs actual PostgreSQL SQL/RLS, but
 * cannot validate independent connection concurrency or network protocol.
 */
export async function createEmbeddedPools() {
  const engine=await PGlite.create();
  for(const path of ['../db/local-init.sql','../db/migrations/001-tenancy.sql','../db/migrations/002-access.sql']) {
    await engine.exec(await readFile(new URL(path,import.meta.url),'utf8'));
  }
  let queue=Promise.resolve();
  function pool(role) {
    return {
      async connect() {
        let unlock;const previous=queue;queue=new Promise(resolve=>{unlock=resolve;});await previous;
        try{await engine.exec(role==='plinth_app'?'SET ROLE plinth_app':'RESET ROLE');}catch(error){unlock();throw error;}
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
  return {admin:pool('admin'),app:pool('plinth_app'),close:()=>engine.close()};
}
