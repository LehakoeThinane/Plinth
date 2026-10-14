# Stand-ins for outside services

Features that depend on outside services are built against local **stand-ins**
until the real accounts exist. Each stand-in implements the same interface the
real adapter will, needs no credentials, and **refuses to start when
`NODE_ENV=production`**. Going live means configuring the real adapter, not
changing feature code. Stand-in screens are labelled TEST MODE.

| Service | Stand-in | Status | Real adapter to add |
| --- | --- | --- | --- |
| Payments | `TestPaymentProvider` (`src/modules/commerce/test-payment-provider.js`) | Built | Paystack or Peach adapter, chosen after the Phase 0 payments gate |
| Media storage and video | Private local files with signed links | Planned next | S3/CloudFront and Mux |
| Email | Outbox written to a local folder or log | Planned | Email provider (not selected) |
| Live updates | Real WebSocket gateway on local Redis | Planned | None; it is production code |
| Sign-in | `TestIdentityProvider` (`src/dev/test-identity-provider.js`) | Built | Auth0 tenant (setup on hold) |
| Staging | `npm run local` (`scripts/local.js`) with demo data | Built | Terraform on AWS (account on hold) |

## Sign-in stand-in and the local run

`npm run local` serves the app on https://localhost:8443 with a self-signed
certificate (created once with OpenSSL into `.local/certs`), because session
cookies are `__Host-`/`Secure` exactly as in production. It seeds the Zoya
Speaks demo hub once (`src/dev/demo-seed.js`), mostly through the app's own
repositories, so the data obeys the same rules as real use.

`TestIdentityProvider` stands in for Auth0. `/test-auth/authorize` shows a
TEST SIGN-IN page listing the demo people and a brand-new visitor. Choosing one
issues a one-use code. The app redeems it through the normal hosted sign-in
callback with S256 PKCE and receives an ES256-signed ID token, using keys
generated per process. Token and key requests are answered in-process. The
page rejects foreign redirect URIs, other client IDs and non-S256 requests.
Swapping in Auth0 means passing its discovered configuration as
`oidcConfiguration` and enabling its issuer, as described in the
[Auth0 setup guide](phase-1/auth0-setup.md).

## Payments stand-in

`TestPaymentProvider` behaves like a hosted checkout. `createSession` returns a
reference and a redirect to `/test-payments/{reference}`, a page marked TEST MODE
with Approve and Decline buttons. Either button produces the provider event the
app would receive by webhook, signed with HMAC-SHA256 using a secret generated
when the process starts (never stored or committed), and the app verifies and
applies it through exactly the same path as `POST /v1/webhooks/payments/test`.
It adds a pretend fee (2.9% + R1) so the ledger records a fee line. Sessions live
in memory and expire after 30 minutes; a restart forgets them.

Anyone who reaches a test payment page can approve it; real providers
authenticate the payer. The page exists only while the stand-in is configured.

### Swapping in a real provider

A provider adapter needs:

- `name`: used in `/v1/webhooks/payments/{name}` and stored on orders.
- `createSession({orderId, hubId, amountCents, returnUrl, description})` →
  `{reference, redirectUrl}`; `redirectUrl(reference)` for retried checkouts.
- `verifyWebhook(rawBody, headers)` → `{provider, id, type, reference,
  amountCents, feeCents, payloadHash}` or `null`, mapping the provider's events
  to `payment.succeeded` / `payment.failed`.

Pass it as `paymentProvider` to `createApplication`/`createManagedApplication`
with a `paymentsPool` logged in as `plinth_payments`, keep its webhook secret in
the secret manager, and register the webhook URL with the provider. Split
payments, subaccounts and VAT need the provider and counsel answers recorded in
the Phase 0 decision register.
