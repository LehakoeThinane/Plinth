# Module boundaries

The composition root owns infrastructure and injects interfaces. src/modules/index.js lists the intended owners; these modules are skeletons, not implemented features.

Identity owns global users and auth links; Tenancy owns hubs/membership/context; Catalogue owns product structure and prices; Commerce owns orders/ledger/seats; Access owns entitlement decisions; Content owns delivery/progress; Library owns publishing; Community owns spaces/posts/moderation; Messaging owns conversations/realtime; Compliance owns consent/retention/audit; Outbox owns transaction events and consumers.

No module may create a database pool or select a tenant from unverified request roles. Database drivers live in src/db. Business queries run through TenantDatabase; test and migration utilities use separate roles. Cross-module commerce/access changes share one transaction, rather than importing another module's database tables directly. Vendor APIs are injected ports. Production authentication must verify issuer, audience, signature and subject/account linking; client role/company headers are ignored.

The architecture check blocks new database-driver imports outside src/db and rejects unregistered module folders. It is a guardrail, not a proof that arbitrary SQL is safe. RLS and adversarial DB tests remain required.

Authentication bootstrap is a separate infrastructure boundary: AuthRepository
uses a dedicated plinth_auth pool with no table privileges and invokes only
explicit account-resolution/session functions. These global identity operations
precede tenant context, so they do not use the business TenantDatabase wrapper.
Only cryptographically verified issuer/subject values reach account resolution.
The authentication pool must never be supplied to business repositories.

OrganisationRepository uses the business tenant-context wrapper with a verified
global user. Its controlled functions are owned by plinth_identity_executor,
a separate non-login/non-bypass role with explicit RLS policies. It neither
resolves auth subjects nor grants hub roles, seats or entitlements. Membership
mutations share an organisation revision lock and append an audit event atomically.
