import { AccessService } from './access.js';
import { TenantDatabase } from './db/tenant.js';
import { PostgresAccessRepository } from './db/access-repository.js';
import { MemoryAccessCache } from './cache/memory.js';
import { createApi } from './http/server.js';
/** Composition root: infrastructure is injected and owned by the caller. */
export function createApplication({pool,authenticate,cache=new MemoryAccessCache(),onError}) {
  if(!pool || typeof authenticate!=='function')throw Error('Database and verified authentication adapters are required');
  const database=new TenantDatabase(pool);
  return createApi({authenticate,onError,accessForPrincipal:principal=>
    new AccessService(new PostgresAccessRepository(database,principal.userId),cache)});
}
