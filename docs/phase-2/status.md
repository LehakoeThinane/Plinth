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

## Next

1. Lesson content and protected assets (text first; files need storage).
2. Checkout and entitlements, once the payment provider decision is made.
