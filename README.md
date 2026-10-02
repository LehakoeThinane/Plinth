# Plinth implementation foundation

## Branch workflow

Develop and push changes to `dev` first. Both CI workflows run on every push to
`dev` and on pull requests targeting `dev` or `main`. Promote validated changes
from `dev` to `main` through a reviewed pull request after all checks pass.
Do not push development changes directly to `main`. Repository branch protection
must be configured separately to enforce this policy; workflow triggers alone
do not prevent direct pushes or merges.

This workspace builds the Enterprise Knowledge Exchange as a modular JavaScript
application with PostgreSQL persistence and configurable managed authentication.
Local technical foundations are verified; production configuration and deployment
are still pending.

## Implemented

- Tenant-scoped target and ancestor resolution through an injected repository.
- Authoritative user access version and hub epoch checks before access decisions.
- Inherited company boundaries and paid-parent entitlement requirements.
- A separate metadata-only public listing operation.
- Recipient authorisation at message delivery, including suspension and company removal.
- Progress conflict handling: monotonic completion/furthest position, independently mutable resume position.
- Sixteen executable regression cases.

## Run tests

Requires Node.js 22 or later. Run npm ci, then npm test and npm run test:tenant. PostgreSQL integration tests use the pg dependency and require the local database described in docs/environments.md.

## Persistence contract and remaining work

A lesson/product PostgreSQL repository adapter is now implemented in src/db/access-repository.js. Other target types remain to build. withSnapshot must run on the PostgreSQL primary in a tenant-scoped, consistent transaction; getVersions and getAccessSummary must use the same snapshot. It must enforce RLS, active organisation membership, ancestor integrity and complete parent resolution. Snapshot authorisation permits an operation authorised immediately before a concurrent revocation; it must not use a lagging replica. Version counters must change atomically with every access-affecting write.

The cache adapter must enforce its TTL. Cache failures fall back to the database. Keys contain both hub and user. An older concurrent cache write can reduce cache efficiency but is rejected by subsequent authoritative version checks.

The gateway must call recipients immediately before routing each event and send only to returned recipients. This is a conservative DB-backed implementation, not a five-minute poll. Conversation participation must be read authoritatively; ordinary hub conversations are not automatically tied to a course seat. Space authorisation must additionally use its own inherited access requirements.

The progress persistence adapter must lock the learner/lesson row (or use an atomic revision predicate and retry), apply mergeProgress, and commit atomically. It must persist idempotency keys with request payload validation to return the same result for a retry. The helper itself does not provide persistence or network idempotency. Server-side lesson-duration validation and completion criteria remain to be defined. Rejected stale resume changes should be reconciled in the client rather than silently reported as a successful resume update.

Still to build: the complete product schema beyond the initial migrations, other target adapters, managed authentication integration, outbox relay/gateway, token renewal integration, storefront and learner UI, payments, seat-grant audit records, deletion/retention policy, and browser offline-queue fault tests. The tests here exercise domain behaviour with a fake repository; they do not prove PostgreSQL policies or Mux playback behaviour.

## Specification corrections used

- Token renewal remains independent of progress writes; uninterrupted renewal and DRM licence duration require vendor/player integration testing.
- All inherited access requirements apply; an asset may belong to a library item rather than a product.
- Message delivery checks current user access, not only participant revisions or Redis revocation events.
- Completion and resume position are separate so intentional rewinds work.
- Legal retention periods must be established per record type; a blanket seven-year rule is not assumed.

## Sprint 0

See [Sprint 0 status](docs/sprint-0.md), [validation questions](docs/validation.md), [retention matrix](docs/retention.md), and [environment setup](docs/environments.md). PostgreSQL/Redis Compose and an RLS integration harness are added; live PostgreSQL checks remain unverified until the Docker engine is available.

The continuation adds six HTTP tests (npm run test:http). These verify routing/authentication boundaries with a fake service; actual RLS-backed HTTP cases live in test/postgres.test.js and remain unverified until PostgreSQL is available. No development token issuer or trusted-header authentication bypass is included.

## Database verification without Docker

Run npm run test:db:embedded. All 21 embedded SQL/RLS and database-backed HTTP checks pass. Full PostgreSQL 17 integration is still a separate CI requirement; the test-only embedded runner does not validate concurrent independent connections.

## Current Phase 0 status

The Phase 0 foundation was verified locally against full PostgreSQL 17 and Redis.
See [Phase 0 acceptance](docs/phase-0/status.md) for evidence and remaining
vendor/legal and AWS staging gates, and the Phase 1 status for current test counts.
npm run dev starts a localhost health shell; it does not issue credentials or
deliver protected content.

Terraform staging/state-bootstrap configurations are now available and provider-schema validated. See infra/README.md. Preparation is complete; overall Phase 0 remains pending external vendor/legal and real AWS account/deployment evidence.

## Phase 1 in progress

See [Phase 1 status](docs/phase-1/status.md) for implemented consent, global identity,
organisation/SSO configuration, hub creation/joining, resolution and safe branding.
The configured application renders a public storefront shell at `/h/{slug}`.
The managed JWT adapter, persistent host/hub-scoped sessions and authenticated
join/member/admin shells are implemented; real provider configuration and hosted
sign-in integration remain. See [authentication setup](docs/phase-1/authentication.md).
`npm run dev` remains a health shell; it does not enable test authentication or
seed accounts. Apply migrations 003–007 in order to an
existing local database; fresh Compose volumes and CI apply them automatically.
