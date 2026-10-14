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
   `not_yet_supported` (subscription prices, which use their own route), 404 for unpublished,
   company or retired plans. Adding `{orgId, quantity}` buys seats at a per-seat
   price for an organisation; see [company seats](seats.md).
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

## Refunds

Hub owners/admins refund a paid order in full from the Sales page
(`POST /v1/hubs/{hub}/catalogue/sales/{order}/refund`). The provider refunds and confirms with a
signed `payment.refunded` event (the stand-in confirms at once), applied by the same function in
one transaction: the order becomes `refunded`, every sale entry gets a reversing entry with sides
swapped (originals untouched), and the purchase entitlement is revoked, so access ends at once.
Partial refunds are logged as `refund_review` and never half-applied. Migration 026.

## Subscriptions

Members subscribe to a published membership tier (`/h/{slug}/subscribe/{tier}`, linked from
the Membership page) or to a product's subscription price (Subscribe on the product page), with
`POST /v1/hubs/{hub}/subscriptions` (`{tierId}` or `{planId}`, `slug`, `Idempotency-Key`).

- **Start:** a pending subscription and its first order are created; the provider keeps a card
  authorisation. The first verified payment activates the subscription and grants access
  (tier or product entitlement) until the end of the first period. A pending subscription from an
  abandoned checkout never blocks subscribing again; if a second start is paid while one is
  already live, it goes to `review` for a refund instead of being lost.
- **Renewal:** a signed `subscription.renewed` event creates a paid renewal order with its own
  balanced ledger entries and extends the period and access.
- **Failed renewal:** `subscription.renewal_failed` marks the subscription `past_due` and keeps
  access for a 7-day grace period after the paid period.
- **Cancel:** `POST .../subscriptions/{id}/cancel` stops renewals; access runs to the end of the
  paid period, and later renewal events are ignored.
- **Refund of the first payment** ends the subscription and its access.

Members manage subscriptions at `/h/{slug}/subscriptions`. With the stand-in provider, a TEST
MODE page simulates successful and failed renewals. Prices are re-checked against the published
tier or subscription plan, as for purchases. Upgrades and downgrades with pro-rated charges, and
the job that ends access after grace without an event, wait for the real provider's stored-card
behaviour. Migration 027 adds `commerce.subscriptions`, order kinds, tier order lines and
subscription-linked entitlements.

It also narrows duplicate detection: only a repeated provider event id is treated as a
duplicate. Before, any uniqueness failure inside the payment function was reported as
"duplicate", which could have hidden a real payment.

## Not yet built

VAT (needs providers' VAT registration and invoices), chargebacks, partial refunds, the 15-minute reconciliation job, settlement import,
upgrades/downgrades,
receipts by email, and a real provider adapter.
