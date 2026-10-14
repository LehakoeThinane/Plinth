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
import { LogoService } from './modules/tenancy/logo-service.js';
import { DomainRepository } from './db/domain-repository.js';
import { DomainVerification } from './modules/tenancy/domain-verification.js';
import { OrganisationDomainRepository } from './db/organisation-domain-repository.js';
import { OrganisationDomains } from './modules/identity/organisation-domains.js';
import { CatalogueRepository } from './db/catalogue-repository.js';
import { LearningRepository } from './db/learning-repository.js';
import { LibraryRepository } from './db/library-repository.js';
import { CommunityRepository } from './db/community-repository.js';
import { CommunityService } from './modules/community/community-service.js';
import { MessagingRepository } from './db/messaging-repository.js';
import { TierRepository } from './db/tier-repository.js';
import { CommerceRepository,PaymentsRepository } from './db/commerce-repository.js';
import { SeatRepository } from './db/seat-repository.js';
import { CheckoutService } from './modules/commerce/checkout-service.js';
/** Composition root: infrastructure is injected and owned by the caller. */
export function createApplication({pool,authenticate,browserSessions,hostedSignIn,accountLinks,brandingStore,domainVerificationPool,resolveDomainTxt,paymentProvider,paymentsPool,cache=new MemoryAccessCache(),onError}) {
  if(!pool || typeof authenticate!=='function')throw Error('Database and verified authentication adapters are required');
  const database=new TenantDatabase(pool);
  const verifier=domainVerificationPool?new TenantDatabase(domainVerificationPool):undefined;
  const domainForPrincipal=verifier?principal=>new DomainVerification({repository:new DomainRepository(database,verifier,principal.userId),resolveTxt:resolveDomainTxt}):undefined;
  const orgDomainsForPrincipal=verifier?principal=>new OrganisationDomains({repository:new OrganisationDomainRepository(database,verifier,principal.userId),resolveTxt:resolveDomainTxt}):undefined;
  return createApi({authenticate,browserSessions,hostedSignIn,accountLinks,brandingStore,domainForPrincipal,orgDomainsForPrincipal,
    catalogueForPrincipal:principal=>new CatalogueRepository(database,principal.userId),publicCatalogue:new CatalogueRepository(database),
    learningForPrincipal:principal=>new LearningRepository(database,principal.userId),
    libraryForPrincipal:principal=>new LibraryRepository(database,principal?.userId??null),
    communityForPrincipal:principal=>new CommunityService({access:new AccessService(new PostgresAccessRepository(database,principal.userId),cache),userId:principal.userId}),
    moderationForPrincipal:principal=>new CommunityRepository(database,principal.userId),
    messagingForPrincipal:principal=>new MessagingRepository(database,principal.userId),
    tierForPrincipal:principal=>new TierRepository(database,principal.userId),seatsForPrincipal:principal=>new SeatRepository(database,principal.userId),publicTiers:new TierRepository(database),
    // Commerce needs both a payment provider adapter and the payments database login.
    ...(paymentProvider&&paymentsPool?{paymentProvider,payments:new PaymentsRepository(paymentsPool),
      ordersForPrincipal:principal=>new CommerceRepository(database,principal.userId),
      checkoutForPrincipal:principal=>new CheckoutService({orders:new CommerceRepository(database,principal.userId),provider:paymentProvider,payments:new PaymentsRepository(paymentsPool)})}:{}),logoForPrincipal:brandingStore?principal=>new LogoService({store:brandingStore,hubs:new HubRepository(database,principal.userId)}):undefined,onError,noticeForPrincipal:principal=>new NoticeRepository(database,principal.userId),identityForPrincipal:principal=>new IdentityRepository(database,principal.userId),
    organisationForPrincipal:principal=>new OrganisationRepository(database,principal.userId),publicHubs:new HubRepository(database),hubForPrincipal:principal=>new HubRepository(database,principal.userId),consentForPrincipal:principal=>new ConsentRepository(database,principal.userId),accessForPrincipal:principal=>
    new AccessService(new PostgresAccessRepository(database,principal.userId),cache)});
}

/** Configured JWT access-token and persistent browser-session composition.
 * The caller owns both pools and supplies administratively trusted hub origins.
 * Optional trusted OIDC configuration enables the hosted sign-in routes.
 * No provider account or issuer activation is provisioned here.
 */
export function createManagedApplication({pool,authPool,auth,oidcConfiguration,originForHub,brandingStore,domainVerificationPool,resolveDomainTxt,paymentProvider,paymentsPool,cache,onError}) {
  if(!authPool||!auth||typeof originForHub!=='function')throw new Error('Managed auth configuration and separate auth pool required');
  const repository=new AuthRepository(authPool);
  const authenticate=createManagedAuthenticator({...auth,resolveUser:(issuer,subject)=>repository.resolveUser(issuer,subject)});
  const browserSessions=new BrowserSessions({store:repository,originForHub});
  const hostedSignIn=oidcConfiguration?new HostedSignIn({configuration:oidcConfiguration,store:repository,sessions:browserSessions,
    resolveUser:(issuer,subject)=>repository.resolveUser(issuer,subject),
    linkIdentity:(sessionHash,issuer,subject)=>repository.linkIdentity(sessionHash,issuer,subject)}):undefined;
  const accountLinks=hostedSignIn?accountLinksFor(hostedSignIn,repository):undefined;
  return createApplication({pool,authenticate,browserSessions,hostedSignIn,accountLinks,brandingStore,domainVerificationPool,resolveDomainTxt,paymentProvider,paymentsPool,cache,onError});
}

/** Sign-in-method management: linking needs hosted sign-in; both act on the browser session. */
export function accountLinksFor(hostedSignIn,repository) {
  return {begin:(req,hub,principal)=>hostedSignIn.beginLink(req,hub,principal),
    unlink:(principal,input)=>repository.unlinkIdentity(principal.sessionHash,input)};
}
