import pg from 'pg';
import { MaintenanceRepository } from '../src/db/maintenance-repository.js';
// Operator job: counts what has passed retention; deletes only with --apply.
// The access-log period is a deployment decision; there is deliberately no default.
const apply=process.argv.includes('--apply');
const url=process.env.MAINTENANCE_DATABASE_URL,days=Number(process.env.ACCESS_LOG_RETENTION_DAYS);
const hours=Number(process.env.IDEMPOTENCY_RETENTION_HOURS??168);
if(!url||!Number.isInteger(days)) {
  console.error('MAINTENANCE_DATABASE_URL (the plinth_maintenance login) and ACCESS_LOG_RETENTION_DAYS are required.');
  process.exit(2);
}
const pool=new pg.Pool({connectionString:url,max:1,connectionTimeoutMillis:10000});
try {
  const records=new MaintenanceRepository(pool);
  const lessonOpens=await records.expireLessonOpens(days,apply),progressRequests=await records.expireProgressRequests(hours,apply);
  console.log(JSON.stringify({dryRun:!apply,retention:{accessLogDays:days,idempotencyHours:hours},
    [apply?'removed':'wouldRemove']:{lessonOpens,progressRequests}}));
}catch(error){console.error(error.message);process.exitCode=1;}
finally{await pool.end();}
