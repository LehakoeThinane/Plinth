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

## Remaining Phase 1 scope

Managed authentication selection/configuration and subject linking; global
organisation model and organisation admins; join/create-hub workflows; slug and
verified custom-domain resolution; host-scoped sessions; safe branding;
storefront/admin/member screens and consent capture UI; company SSO configuration
model. Purpose-notice publication currently requires an administrative migration
or controlled database operation; its provider-admin interface is not built.

The existing identity/membership tables are a starting point, not acceptance of
the full global account model. Auth-provider setup requires an actual tenant and
configuration. No production payment/video integration has been introduced.

Next implementation slice: global identity/auth links and organisation schema,
then managed sign-in and hub joining. Overall Phase 0 external gates remain open.
