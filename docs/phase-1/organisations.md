# Organisation administration

Organisation identity is global. A company admin's authority does not depend on
hub staff status; a provider hub owner cannot administer another company by
passing its ID or role headers. Browser sessions remain bound to their original
hub/origin, including the global-account screens exposed within that hub.

## Setup

Create `plinth_identity_executor NOLOGIN NOSUPERUSER NOBYPASSRLS` through controlled
database bootstrap before migration 009. It owns only organisation functions,
never tables; it receives explicit RLS permissions and limited table grants.
Neither application nor auth login roles may be members of it. Migration execution
needs the same temporary function-ownership transfer capability as migration 007.
`db/local-init.sql` provisions it for fresh local/CI databases. Apply migration 009
after 008 on existing volumes; do not discard volumes to apply migrations.

## Routes

All routes use verified identity; cookie mutations require exact Origin and CSRF.
The hub ID supplies transaction/session context, not organisation ownership.

| Route | Operation |
| --- | --- |
| GET `/v1/hubs/{hub}/account` | Caller account and active organisations only |
| POST `/v1/hubs/{hub}/organisations` | Create with `displayName`, `legalName`, `type` (`company` or `provider`) |
| GET `/v1/hubs/{hub}/organisations/{org}` | Active org admin view: profile, members, invitation metadata, latest 100 events |
| PUT `/v1/hubs/{hub}/organisations/{org}` | Admin rename with `displayName`, `legalName` |
| POST `/v1/hubs/{hub}/organisations/{org}/invitations` | Admin invite existing `userId`; returns invitation ID and raw code once |
| DELETE `/v1/hubs/{hub}/organisations/{org}/invitations/{id}` | Admin revoke pending invitation |
| POST `/v1/hubs/{hub}/organisations/{org}/accept` | Intended signed-in account submits `token` |
| PUT `/v1/hubs/{hub}/organisations/{org}/members/{user}` | Admin sets `role` to `admin` or `member` |
| DELETE `/v1/hubs/{hub}/organisations/{org}/members/{user}` | Admin ends membership |
| GET `/v1/hubs/{hub}/organisations/{org}/domains` | Admin lists pending domain claims and verified domains |
| POST `/v1/hubs/{hub}/organisations/{org}/domains` | Admin creates/rotates a DNS challenge for `{domain}`; returns the TXT value once |
| POST `/v1/hubs/{hub}/organisations/{org}/domains/verify` | Admin checks the current DNS proof for `{domain}` |
| DELETE `/v1/hubs/{hub}/organisations/{org}/domains` | Admin removes that organisation's claim and verified domain |

An account shares its ID from the organisations screen. The administrator creates
a targeted invitation and privately shares the organisation ID/code. Codes expire
after seven days on the database clock and are hashed before persistence. The code
alone cannot join: acceptance also requires the target's verified global identity.
No email lookup or account linking is performed. Optional role claims in invitations
are ignored; acceptance grants member status only. Accepted admins are never demoted
by an old invitation. Creating an organisation declares identity; it is not evidence
of incorporation, employer authority, B-BBEE status or payment onboarding.

The organisation revision row serialises administrative writes. Repeatable-read
serialization/deadlock errors retry up to three attempts, then return conflict.
Removal/demotion protects the last active admin and revokes pending invitations
that could otherwise survive authority removal. Ending membership raises access
version through the existing trigger; it does not delete historical records.
Concurrent operations already authorised before removal retain the established
snapshot limit. Forced RLS plus function-only writes enforce the admin boundary.
Audit events contain actor/target IDs, action, role-change detail and time; no codes.
Retention/deletion of audit data requires the record-specific lifecycle still to build.

## Organisation domains

Admins can prove DNS control of a domain, such as the company email domain.
The screen issues a TXT record at `_plinth-verification.{domain}` with a random
`plinth-organisation={64 hex characters}` value, shown once. Only its SHA-256
hash is stored, proofs expire after 24 hours and a new proof replaces the old.
Hub-domain proofs (`plinth-domain=`) never satisfy an organisation claim. DNS
lookup, chunk joining and validation are shared with hub domains through
`src/dns/txt-proof.js`; see [domain setup](domains.md) for resolver behaviour.

Migration 014 adds forced-RLS `identity.org_domain_claims` (identity executor
only) and `identity.org_domains`, which members of the organisation can read and
only the executor can write. A verified domain belongs to one organisation
globally; another organisation's valid proof cannot take it over. Requests,
confirmation and removal take the organisation revision lock, recheck active
admin authority and append `domain_requested`, `domain_verified` or
`domain_removed` events. Confirmation is executable only by the
`plinth_domain_verifier` login, after the application has checked DNS, and
consumes the exact current unexpired challenge.

Verification is evidence of DNS control only. It is not proof of incorporation,
employer authority, B-BBEE status or payment onboarding, and it does not yet
grant anything: SSO routing and seat purchasing may rely on it later. Periodic
ownership rechecks, expiry of verified domains and domain transfers remain to
build. Apply migration 014 after 013 on existing databases.

## Remaining work

The first slice targets existing accounts. New-user/email invitations and delivery,
legal/registration verification beyond domain ownership, bulk administration/pagination, billing/VAT/B-BBEE metadata,
seat assignment and SSO activation are separate work. This screen does not assign
seats or give hub/course access. Invitation metadata remains after expiry for audit;
expired codes cannot be accepted. The admin view lists members/invitations in full
and the latest 100 events; enterprise-scale pagination is not yet implemented.
Live provider/TLS/browser UAT remains outstanding. The fixture tests verify the
actual PostgreSQL and HTTP boundaries, with concurrency additionally tested using
independent real PostgreSQL connections.
