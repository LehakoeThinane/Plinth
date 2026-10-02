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
cannot change membership roles. The eighth slice below adds logo uploads/serving.
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

## Sixth implemented slice: global organisation administration

Migration 009 adds self-declared company/provider type and legal name, targeted
seven-day invitations, and an organisation audit trail. A global account can
create an organisation and becomes its first admin atomically. Active admins can
rename it, invite an existing account, revoke invitations, promote/demote accepted
members, and end membership. No hub membership, entitlement or seat is granted by
organisation creation or invitation acceptance.

Invitations are bound to an exact existing global user ID. Only that signed-in
account can accept the one-use code; only a hash is stored. New invitations grant
member status only. Removing a member revokes pending invitations involving them;
demoting/removing an inviter invalidates their invitations. An ended member needs
a deliberate fresh invitation to return. Expired/revoked/used codes cannot join.

All organisation writes use narrowly granted functions owned by the non-login,
non-superuser `plinth_identity_executor`, with forced RLS. Runtime has no direct
table mutation or executor-role membership. Updating the organisation revision
serialises admin changes; stale repeatable-read writers retry. The last active
admin cannot be removed/demoted, including concurrent removal attempts. Existing
membership triggers raise the user's access version and defeat cached company
access after removal. Audit writes occur in the same transaction and cannot be
altered/deleted by runtime roles.

The authenticated `/h/{slug}/organisations` screen lists the caller's organisations,
shows their account ID, and supports these workflows with CSRF protection and
escaped text. Organisation authority is independent of hub roles. Invitation codes
are pasted into a form, never placed in URLs or browser storage; no email is sent.

Validation: `npm run verify` passed 118 checks; full PostgreSQL 17 passed 68 checks.
Tests cover restricted executor privileges, policy failures, isolation, intended
account acceptance, expiry/replay/revocation, role changes, concurrent last-admin
protection, HTTP/CSRF boundaries and cached company-access revocation.
Bootstrap the identity executor before applying 009 after 008 on existing databases.
Fresh Compose volumes and CI do this automatically. See [organisation setup](organisations.md).

## Seventh implemented slice: purpose-notice publishing

Active hub owners/admins can now publish optional consent purposes and revisions
through the hub admin screen and `GET/PUT /v1/hubs/{hub}/notices`. Publishing an
existing purpose requires the version the admin last viewed; concurrent edits
return conflict rather than overwrite each other. A new purpose requires an
explicit null expected version. The API accepts notices up to 10,000 characters,
including Unicode, under a bounded request size. Cookie writes retain CSRF and
host/hub isolation, and notice text renders as escaped text.

Migration 010 adds forced-RLS publication history and restrictive admin policies
for purpose inserts/updates. Each write appends its version, text, actor and time
in the same transaction. A constrained non-login consent executor owns only the
audit trigger; runtime cannot mutate history or assume the role. Version reuse
and same-version text edits are rejected by the database, preventing old grants
from becoming valid again. Existing current notices are imported with unknown
original author/date rather than invented metadata. Versions observed in older
consent records are also reserved, preventing reuse after an upgrade.

Old consent grants become inactive on publication of a revision. Consent audit
snapshots remain intact, and users can explicitly agree to the current notice.
Publication racing a consent save either preserves the exact old snapshot or
returns conflict for review. Optional consent never grants membership/access.

Validation: 127 local checks passed, including a legacy upgrade test and 76 embedded database checks;
76 integration checks passed against real PostgreSQL 17. Coverage includes
admin/RLS permissions, removed policy detection, immutable history, version reuse,
concurrent publication and consent, CSRF, body limits, Unicode and escaped forms.
Bootstrap `plinth_consent_executor` before migration 010 after 009 on existing
databases; fresh Compose/CI bootstrap does so automatically.
See [notice publishing](notices.md) for the API and deployment limits.

## Eighth implemented slice: logo uploads and public branding assets

The configured application now accepts raw PNG/JPEG/WebP logo uploads from active
hub owners/admins and exposes upload/removal controls in the admin screen. Images
are decoded and converted to bounded WebP under byte/pixel limits, with metadata
removed. SVG/HTML, MIME mismatches, corrupt images and animations are rejected.
Cookie mutations retain CSRF and host/hub isolation. Database publication rechecks
active admin authority after decoding/storage, and failed publication attempts
cleanup of the unpublished object.

An injectable private filesystem adapter supports development persistence with
server-generated UUID keys. Public serving checks the exact current DB pointer;
replaced, removed, foreign-hub and unpublished keys return 404. There is no static
storage listing. Migration 011's non-login branding reader has narrowly granted
SELECT/function authority; runtime cannot assume it or bypass ordinary hub RLS.
Old/unpublished objects remain private pending eventual garbage collection.

Validation: 139 local checks passed, including six image/storage tests and 82
embedded database checks. The full 82-check PostgreSQL 17 suite is wired into CI;
the local real-database rerun was blocked by connection timeouts.
Coverage includes decoder/output limits, actual animation, metadata stripping,
storage persistence/traversal, authority loss at publication, restricted DB roles,
tenant isolation, CSRF, the admin form and current-pointer-only serving.
See [branding setup](branding.md). Shared staging object storage, deployment,
ingress rate limits, garbage collection and browser/TLS UAT remain outstanding.

## Remaining Phase 1 scope

Managed provider selection/configuration and real hosted sign-in verification;
explicit account-linking workflow; new-account/email invitations and enterprise
organisation verification; domain ownership verification, TLS/custom-host
routing and browser UAT; shared staging branding storage and lifecycle operations.
Notice retirement, enterprise-scale history pagination and retention/deletion
workflows remain to build.

The existing identity/membership tables are a starting point, not acceptance of
the full global account model. Auth-provider setup requires an actual tenant and
configuration. No production payment/video integration has been introduced.

Next implementation slice: explicit account linking or domain ownership verification.
Overall Phase 0 external gates remain open.
