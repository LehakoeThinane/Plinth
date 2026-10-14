# Payments: checkout, ledger and access

Learners can buy a product with a once-off price (Flow A). This slice runs
against the stand-in payment provider ([stand-ins](../stand-ins.md)); no real
money or credentials are involved.

## Flow

1. **Checkout**: `POST /v1/hubs/{hub}/checkout` with `{planId, slug}` and an
   `Idempotency-Key` header creates a **pending** order for an active hub member
   and returns the provider's payment page. The same key with the same plan
   returns the same order; with a different plan it is `409
   idempotency_key_reused`. Other refusals: `join_first`, `already_owned`,
   `not_yet_supported` (subscriptions and per-seat prices), 404 for unpublished,
   company or retired plans.
2. **Pay**: the buyer approves or declines on the provider's page (TEST MODE).
3. **Webhook**: the provider's signed event reaches
   `POST /v1/webhooks/payments/{provider}`. The signature is verified before
   anything is recorded; access is never granted because the browser returned.
4. **One transaction**: `app.record_payment_event` marks the order paid, writes
   the ledger and creates the entitlement (`source = purchase`), or none of it.
   The buyer's access version rises, so access starts at once.

| Event | Outcome |
| --- | --- |
| Same provider event id again | `duplicate`: nothing changes |
| Amount differs from the order, fee larger than the order, or order lines that do not match the immutable plan prices | `review`: no access; a person checks it |
| `payment.failed` on a pending order | `failed` |
| Unknown reference | `unknown_reference` (logged) |

The price re-check matters because application code wrote the order: a
compromised application cannot create a cheap order for an expensive plan and
have a real small payment unlock it.

## Ledger

Double-entry in whole cents; entries are never edited or deleted (a trigger
refuses it), and corrections will be reversing entries. Each paid order debits
`buyer_payment` and credits `provider_revenue`, `vat_payable` (zero for now) and
`payment_fees`, which always balance.

## Who can do what

- Buyers create and read their own orders and attach the provider reference once.
  They cannot change status.
- Hub owners/admins read the hub's orders and ledger at `/h/{slug}/admin/sales`
  (`GET /v1/hubs/{hub}/catalogue/sales`).
- Only the `plinth_payments` login can apply provider events, through one
  function owned by the non-login `plinth_commerce_executor`. It cannot read
  orders directly, and the application cannot call the function.

Pages: Buy links on product pages lead to `/h/{slug}/checkout/{product}/{plan}`;
buyers follow orders at `/h/{slug}/orders`. Migration 025 adds orders, order
lines, payment events, the ledger and entitlement `source`/`order_id`. Bootstrap
`plinth_commerce_executor` (NOLOGIN) and `plinth_payments` (LOGIN, managed secret)
before applying it after 024; local Compose and CI do this.

## Not yet built

VAT (needs providers' VAT registration and invoices), refunds and chargebacks
with reversing entries, the 15-minute reconciliation job, settlement import,
subscriptions for tiers and products, per-seat purchases and seat assignment,
receipts by email, and a real provider adapter.
