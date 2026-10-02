import { AccessService } from './access.js';
import { TenantDatabase } from './db/tenant.js';
import { PostgresAccessRepository } from './db/access-repository.js';
import { MemoryAccessCache } from './cache/memory.js';
import { createApi } from './http/server.js';
import { ConsentRepository } from './db/consent-repository.js';
import { HubRepository } from './db/hub-repository.js';
import { AuthRepository } from './db/auth-repository.js';
import { createManagedAuthenticator } from './modules/identity/managed-auth.js';
import { BrowserSessions } from './modules/identity/browser-sessions.js';
/** Composition root: infrastructure is injected and owned by the caller. */
export function createApplication({pool,authenticate,browserSessions,cache=new MemoryAccessCache(),onError}) {
  if(!pool || typeof authenticate!=='function')throw Error('Database and verified authentication adapters are required');
  const database=new TenantDatabase(pool);
  return createApi({authenticate,browserSessions,onError,publicHubs:new HubRepository(database),hubForPrincipal:principal=>new HubRepository(database,principal.userId),consentForPrincipal:principal=>new ConsentRepository(database,principal.userId),accessForPrincipal:principal=>
    new AccessService(new PostgresAccessRepository(database,principal.userId),cache)});
}

/** Configured JWT access-token and persistent browser-session composition.
 * The caller owns both pools and supplies administratively trusted hub origins.
 * No provider account, issuer activation or hosted-login UI is provisioned here.
 */
export function createManagedApplication({pool,authPool,auth,originForHub,cache,onError}) {
  if(!authPool||!auth||typeof originForHub!=='function')throw new Error('Managed auth configuration and separate auth pool required');
  const repository=new AuthRepository(authPool);
  const authenticate=createManagedAuthenticator({...auth,resolveUser:(issuer,subject)=>repository.resolveUser(issuer,subject)});
  const browserSessions=new BrowserSessions({store:repository,originForHub});
  return createApplication({pool,authenticate,browserSessions,cache,onError});
}
