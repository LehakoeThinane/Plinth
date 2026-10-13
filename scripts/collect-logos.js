import pg from 'pg';
import { TenantDatabase } from '../src/db/tenant.js';
import { HubRepository } from '../src/db/hub-repository.js';
import { LocalBrandingStore } from '../src/storage/local-branding.js';
import { collectLogos } from '../src/modules/tenancy/logo-collector.js';
// Operator job: lists what would be removed; deletes only with --apply.
const apply=process.argv.includes('--apply');
const root=process.env.BRANDING_ROOT,url=process.env.DATABASE_URL;
if(!root||!url) {
  console.error('BRANDING_ROOT and DATABASE_URL (the plinth_app connection) are required.');
  process.exit(2);
}
const pool=new pg.Pool({connectionString:url,max:1,connectionTimeoutMillis:10000});
try {
  const hubs=new HubRepository(new TenantDatabase(pool));
  const result=await collectLogos({store:new LocalBrandingStore({root}),apply,
    isPublishedLogo:(hubId,file)=>hubs.isPublishedLogo(hubId,file)});
  for(const {hubId,id} of result.removed)console.log((apply?'removed ':'would remove ')+'hubs/'+hubId+'/branding/'+id+'.webp');
  console.log(JSON.stringify({dryRun:result.dryRun,kept:result.kept,recent:result.recent,removed:result.removed.length}));
} finally {await pool.end();}
