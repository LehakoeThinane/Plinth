# Phase 2 implementation status

Started 14 October 2026 on `dev`. Phase 2 builds the product catalogue and the
path to a first sale: a provider lists a course, a learner buys it and watches it.
Phase 1 local work is complete; its account-dependent items remain on hold (see
[Phase 1 status](../phase-1/status.md)).

## First implemented slice: catalogue and public shelf

Migration 016 adds product types, summaries and publication dates, ordered
modules and lessons, immutable ZAR plans, and database rules for authoring and
publishing. Hub owners/admins author products through
`/v1/hubs/{hub}/catalogue/products`; the storefront shows a public shelf and
product pages with outline and prices. Company products stay inside their
organisation's boundary, refuse prices and never reach the shelf.

Validation: `npm run verify` passed 183 checks; the full PostgreSQL 17 suite
passed 114 checks (seven new) on three consecutive runs. Coverage includes
database-derived admin authority against forged staff flags, policy-audit
detection, draft visibility, publish preconditions, immutable prices, the
last-price guard under concurrent retirement, company boundary hiding, foreign
module rejection, cross-hub isolation, HTTP/CSRF and escaped storefront output.
See [catalogue](catalogue.md).

## Second implemented slice: catalogue admin screens

Hub owners/admins can now author products in the browser: a product list with a
create form at `/h/{slug}/admin/products`, and an editor for details, modules,
lessons, prices and publishing at `/h/{slug}/admin/products/{id}`. No API or
database rules changed; the screens call the catalogue API.

Validation: `npm run verify` passed 184 checks; the full PostgreSQL 17 suite
passed 115 checks on three consecutive runs. The new check covers sign-in
redirects, member denial, escaping, outline and price rendering, publish-button
state and company-product handling. Browser-level UAT of the forms is pending.

## Third implemented slice: lesson content

Lessons carry plain written content, authored per lesson in the product editor.
Opening a lesson makes the access decision and reads the content in the same
snapshot, returning the content, a locked preview or 404 (Flow C). Free lessons
open signed out; company lessons need both an entitlement and company
membership. Migration 017 adds `content.lesson_bodies` under hub, company and
admin-write policies. The preview flag was relabelled: it shows a locked teaser,
it never makes a lesson free.

Validation: `npm run verify` passed 189 checks; the full PostgreSQL 17 suite
passed 120 checks (five new) on five consecutive clean runs. Coverage includes
admin-only and boundary-scoped authoring, buyer/member/anonymous/staff
outcomes, company double checks, revocation and drafts, credential handling and
escaped rendering. Two test fixes: cleanup now removes lesson bodies before
users, and a notice-history check no longer assumes cross-transaction clock
order. See [lesson content](lessons.md).

## Fourth implemented slice: progress and My learning

Learners can save lesson progress and see their courses. `PUT
/v1/hubs/{hub}/lessons/{id}/progress` decides access and writes in one
transaction, locks the progress row, applies the existing merge rules (forward-only
completion and furthest position, reportable resume conflicts) and stores
idempotency keys checked against the payload. The **My learning** page lists held
and started products with completion and a Continue link; lesson pages gain
**Mark as complete** for signed-in learners. Migration 018 adds the progress and
idempotency tables under per-learner RLS with a forward-only trigger.

Validation: `npm run verify` passed 194 checks; the full PostgreSQL 17 suite
passed 125 checks (five new) on three consecutive runs. Coverage includes
access-gated saves, replay and key-reuse handling, forward-only merging and
stale resume conflicts, database refusal of backward or cross-learner writes,
concurrent same-key saves applying once, learning-list inclusion and
revocation, and HTTP identity/CSRF/key requirements. See
[lesson content and progress](lessons.md).

## Fifth implemented slice: lesson-open log and retention

Every delivery of lesson content to a signed-in person is logged (who, lesson,
time, device) in the same transaction as the access decision. Hub admins see it
in the product editor and through a paged API; runtime cannot edit or delete it.
`npm run records:expire` expires lesson opens after a deployment-set period (no
default, since the legal period is unconfirmed) and idempotency records after
seven days, through a separate `plinth_maintenance` login that can only call two
retention functions. Migration 019 adds the log, the functions and policies.

Validation: `npm run verify` passed 197 checks; the full PostgreSQL 17 suite
passed 128 checks (three new) on three consecutive runs. Coverage includes what
is and is not logged, device truncation, admin-only reads, refusal of updates,
deletes and forged entries, maintenance-only retention with dry-run counts,
period validation, and HTTP/editor visibility. See
[lesson content and progress](lessons.md#lesson-open-log).

## Sixth implemented slice: library (articles)

Providers write, publish and archive library articles with `public`, `members`,
`tier` or buyers-only visibility and topics. Items open through the same access
decision as lessons, with locked previews explaining how to unlock them, and the
public library pages by date and filters by topic. Migration 020 adds
`library.items`. Podcasts and videos wait for media storage.

Validation: `npm run verify` passed 201 checks; the full PostgreSQL 17 suite
passed 132 checks (four new) on three consecutive runs. Coverage includes
admin-only authoring, company-product and topic rejection (including at the
database), every visibility outcome for members, outsiders, tier holders, buyers,
suspended members and staff, unpublished linked products, archive behaviour,
paging and topic filters, and HTTP/admin pages with escaping. See [library](library.md).

## Next

Working through the remaining locally buildable launch requirements in order:
community (#6), enquiries (#3, the base for messaging #7), then membership-tier
set-up (#8). Protected file assets and checkout remain blocked on storage and the
payment provider decision.
