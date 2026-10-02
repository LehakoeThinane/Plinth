# Phase 1 implementation status

Started 2 October 2026 on `dev`. Phase 1 is in progress.

## First implemented slice: per-hub consent

- Migration `003-consent.sql` adds purpose notices, current decisions, and an
  append-only runtime audit trail containing the notice text and version.
- Forced RLS isolates all three new hub-owned tables. Decisions and events are
  additionally restricted to the verified user; client identity headers are ignored.
- `GET /v1/hubs/{hubId}/consents` lists public purpose notices and the caller's
  decisions. `PUT` accepts `{purpose, granted, noticeVersion}` using the existing
  injected verified bearer authenticator. This does not introduce a token issuer.
- Active membership is required to grant consent. Withdrawal remains available
  after suspension or membership ending. Consent does not grant membership/access.
- Stale notices are rejected. A changed notice makes an older grant inactive in
  the repository response until consent is captured again.
- Database triggers validate the notice version and record changes in the same
  transaction. Runtime cannot delete decisions or alter/delete audit events.
- Both embedded and network PostgreSQL harnesses cover consent and HTTP isolation.
  CI applies the migration before integration tests.

Validation: `npm run verify` passed 56 checks; `npm run test:db` passed 28 checks
against local PostgreSQL 17. No managed-provider sign-in is claimed.

For an existing local volume, apply migration 003 with the administrative
database connection. Compose initialization applies it automatically only to a
new volume; never discard an existing volume just to apply a migration.

## Second implemented slice: global identity and organisations

Migration `004-identity.sql` adds global organisations, display names, organisation
admin roles, and unique issuer/subject links to global users. Existing organisation
IDs are backfilled without inventing company names; organisation memberships and
company boundaries now have foreign keys to the organisation model.

The identity repository returns only the authenticated user's account and active
organisations. Global account identity is independent of hub membership. Runtime
cannot provision users, link accounts, elevate organisation roles or edit SSO
configuration. Linking remains a controlled administrative operation; no email-only
account linking is implemented. A managed-provider authentication adapter and its
provisioning/linking flow still need to be built.

Company SSO configuration supports OIDC/SAML metadata and is readable only by an
active organisation admin. It contains no secrets, fetches no metadata URLs and
cannot be enabled yet. Full SSO implementation remains Phase 5. Global identity
RLS policies are now checked by the CI policy harness as well as isolation tests.

The application composition root now exposes the consent routes through its
injected verified authentication adapter. Database-backed HTTP tests exercise this
composition rather than building a separate test-only server configuration.

Validation: `npm run verify` passed 62 checks; full PostgreSQL 17 passed 34 checks.
Apply migration 004 after 003 on existing development databases; fresh Compose
volumes and CI apply both automatically.

## Third implemented slice: hub onboarding, resolution and branding

Migration `005-hubs.sql` adds hub profiles and custom-domain records, with forced
RLS on both tables. A narrow database function resolves public hub metadata by
slug or by an administratively verified custom domain. Pending domains return
404. Runtime cannot assert domain ownership or modify verification records.
DNS proof, TLS provisioning and custom-host routing are still to implement.

Verified global accounts can create hubs through `POST /v1/hubs`; creation of the
hub, profile and owner membership is atomic. `POST /v1/hubs/{id}/join` adds only a
member role and is idempotent. Closed hubs reject new joins, and joining cannot
reactivate a suspended or ended membership. Consent remains a separate explicit
decision; joining never grants optional consent.

`GET /v1/hubs/{id}/membership` returns only the active caller's membership.
`PUT /v1/hubs/{id}/branding` allows only active owners/admins to change safe text,
hex colour, an enumerated font or an image path belonging to that hub. Runtime
cannot change membership roles. Branding image uploads/serving remain to build.
`GET /v1/hubs/resolve?slug=...` or `?hostname=...` returns public branding; it never
returns identity, company or membership information. Forwarded host headers are
not used for this lookup.

`GET /h/{slug}` renders the public storefront shell with escaped text and a
restrictive content security policy. It contains no provider scripts, catalogue
data, login form or authenticated admin/member surface. Full storefront content
and commerce belong to later phases.

Validation: `npm run verify` passed 71 checks, and full PostgreSQL 17 passed 43
checks. New cases cover transaction rollback, slug conflicts, join idempotency,
role forgery, tenant isolation, ended/suspended membership, domain verification,
branding injection and storefront text escaping. Existing databases need
migration 005 after 004; fresh Compose volumes and CI apply it automatically.

## Fourth implemented slice: managed JWT adapter, browser sessions and shells

The configurable managed JWT adapter verifies signature, issuer, dedicated API
audience, token type and required expiry/issued-at/subject claims before resolving
global users. Migration 006 adds administratively enabled issuers and persistent
session storage. A separate authentication role has function-only permissions,
while the application role cannot provision accounts or read session credentials.
Concurrent provisioning of one issuer/subject creates only one global account.

Browser sessions use host-only Secure/HttpOnly cookies, stored credential hashes,
bounded expiry, exact trusted hub origins, CSRF checks and persistent logout.
The application composition can wire these through `createManagedApplication`.
Authenticated join/member/admin shells provide optional consent capture,
per-purpose grant/revoke, safe branding edits and sign out. They recheck active
membership/role from the database and cannot cross a session's hub boundary.

Validation: `npm run verify` passed 90 checks; full PostgreSQL 17 passed 52 checks.
Coverage includes real signed test tokens through account resolution and the HTTP
access path, invalid claims/signatures, constrained authentication privileges,
concurrent account provisioning, cookie/host isolation, CSRF, shells and logout.
Provider sign-in, HTTPS transport and browser/device UAT are not yet verified.
See [authentication setup](authentication.md) for configuration and remaining work.

## Fifth implemented slice: hosted OIDC sign-in and hub-creation screen

The configured application now redirects users to a managed OIDC provider with
authorization code/S256 PKCE, state and nonce. Migration 008 stores ten-minute
login attempts behind function-only auth permissions and forced RLS. The callback
requires the matching host-only login cookie, consumes the attempt atomically,
verifies the provider response and ID-token signature/issuer/audience/nonce,
then resolves the enabled issuer/subject and establishes a bounded session.
Destinations are fixed to hub application screens; arbitrary redirect URLs fail.
No access/refresh/ID token is persisted or sent to browser JavaScript.

Public storefronts expose sign-in/join links when hosted login is configured.
Unauthenticated application screens redirect to hosted login. The hub-creation
screen accepts global accounts without requiring membership in the current hub,
and uses the CSRF-protected existing atomic creation API. A newly created hub
needs its own approved origin/session before administration.

Validation: `npm run verify` passed 107 checks; full PostgreSQL 17 passed 57 checks.
The provider fixture exercises the actual OIDC library, token endpoint and JWKS
validation, including forged signatures, wrong issuer/audience/nonce, expiry,
PKCE failure and replay. Database tests cover concurrent one-use consumption,
expiry cleanup, restricted roles, HTTP callbacks and hub creation without membership.
This is fixture validation; a real provider tenant, TLS transport and device UAT
are still outstanding. Existing volumes need migration 008 after 007.

## Remaining Phase 1 scope

Managed provider selection/configuration and real hosted sign-in verification;
explicit account-linking workflow; organisation
provisioning/admin workflows; domain ownership verification, TLS/custom-host
routing and browser UAT; branding asset upload/serving.
Purpose-notice publication currently requires an administrative migration
or controlled database operation; its provider-admin interface is not built.

The existing identity/membership tables are a starting point, not acceptance of
the full global account model. Auth-provider setup requires an actual tenant and
configuration. No production payment/video integration has been introduced.

Next implementation slice: organisation provisioning/admin workflows.
Overall Phase 0 external gates remain open.
