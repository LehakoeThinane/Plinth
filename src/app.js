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
import { HostedSignIn } from './modules/identity/hosted-sign-in.js';
import { IdentityRepository } from './db/identity-repository.js';
import { OrganisationRepository } from './db/organisation-repository.js';
import { NoticeRepository } from './db/notice-repository.js';
/** Composition root: infrastructure is injected and owned by the caller. */
export function createApplication({pool,authenticate,browserSessions,hostedSignIn,cache=new MemoryAccessCache(),onError}) {
  if(!pool || typeof authenticate!=='function')throw Error('Database and verified authentication adapters are required');
  const database=new TenantDatabase(pool);
  return createApi({authenticate,browserSessions,hostedSignIn,onError,noticeForPrincipal:principal=>new NoticeRepository(database,principal.userId),identityForPrincipal:principal=>new IdentityRepository(database,principal.userId),
    organisationForPrincipal:principal=>new OrganisationRepository(database,principal.userId),publicHubs:new HubRepository(database),hubForPrincipal:principal=>new HubRepository(database,principal.userId),consentForPrincipal:principal=>new ConsentRepository(database,principal.userId),accessForPrincipal:principal=>
    new AccessService(new PostgresAccessRepository(database,principal.userId),cache)});
}

/** Configured JWT access-token and persistent browser-session composition.
 * The caller owns both pools and supplies administratively trusted hub origins.
 * Optional trusted OIDC configuration enables the hosted sign-in routes.
 * No provider account or issuer activation is provisioned here.
 */
export function createManagedApplication({pool,authPool,auth,oidcConfiguration,originForHub,cache,onError}) {
  if(!authPool||!auth||typeof originForHub!=='function')throw new Error('Managed auth configuration and separate auth pool required');
  const repository=new AuthRepository(authPool);
  const authenticate=createManagedAuthenticator({...auth,resolveUser:(issuer,subject)=>repository.resolveUser(issuer,subject)});
  const browserSessions=new BrowserSessions({store:repository,originForHub});
  const hostedSignIn=oidcConfiguration?new HostedSignIn({configuration:oidcConfiguration,store:repository,sessions:browserSessions,
    resolveUser:(issuer,subject)=>repository.resolveUser(issuer,subject)}):undefined;
  return createApplication({pool,authenticate,browserSessions,hostedSignIn,cache,onError});
}
