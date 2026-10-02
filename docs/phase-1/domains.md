# Custom domain ownership

Configure `createApplication` or `createManagedApplication` with a separate
`domainVerificationPool` authenticated as `plinth_domain_verifier`. Without this
pool, domain administration routes and controls are disabled. The default DNS
adapter uses Node's [DNS Resolver](https://nodejs.org/api/dns.html#class-dnspromisesresolver),
with a dedicated resolver, bounded retries and cancellation deadline for each
query. `resolveDomainTxt` can be injected for tests or a trusted deployment adapter.
Never substitute TXT records or resolver configuration from HTTP request data.

Active hub owners/admins use these endpoints:

| Endpoint | Action |
| --- | --- |
| `GET /v1/hubs/{hub}/domains` | List up to 100 pending claims and verified names each. |
| `POST /v1/hubs/{hub}/domains` | Create/rotate a challenge with JSON `{ "hostname": "learn.company.co.za" }`. |
| `POST /v1/hubs/{hub}/domains/verify` | Check the current DNS proof for the supplied hostname. |
| `DELETE /v1/hubs/{hub}/domains` | Remove that hub's pending claim and hostname mapping. |

The admin screen generates instructions for a TXT record at
`_plinth-verification.{hostname}` with a random `plinth-domain={64 hex characters}`
value. The value appears once; copy it before refreshing. Only its SHA-256 hash
is stored. Proofs expire after 24 hours. Generating a new proof invalidates the
previous one. Verification joins chunks of a single TXT record, never separate
records. A missing/mismatched proof, resolver failure, expiry or concurrent change
returns conflict; retry after reviewing DNS and the current challenge.

Hostnames are canonical lowercase ASCII with bounded DNS labels, an alphabetic
TLD, and at most 232 characters, leaving room for the verification prefix. URLs,
paths, ports, IP literals and private/reserved suffixes are rejected. International
TLDs and broader IDN support remain outside this initial validator.
No HTTP request is made to the hostname being claimed.

Unverified claims are scoped by hub and do not reserve a global hostname. The
database uniquely reserves a verified mapping, so another hub's proof cannot
overwrite it.
Legacy administratively inserted `hub_domains` rows, including unverified rows,
retain their reservations; operators must review/release stale reservations on
upgrade rather than silently discard existing records. The confirmer consumes
the exact current unexpired challenge and
rechecks active admin authority in a new transaction after DNS. A concurrent
revocation after that transaction's snapshot may still permit confirmation; a
revocation committed before confirmation starts prevents it. Cookie writes retain
Origin/CSRF checks and sessions remain bound to the approved host and hub.

Migration 012 adds forced-RLS claims. Ordinary API credentials can manage their
own admin-authorised claims and remove mappings, but cannot set `verified_at`,
insert verified mappings or execute confirmation. The separate verifier has
function-only access and cannot read tables or assume the executor role.
The non-login, non-superuser/non-bypass executor has narrow grants and forced RLS.
Keep verifier credentials restricted to the trusted DNS verification component.
Bootstrap these roles before applying 012 after 011 on an existing database:

```sql
CREATE ROLE plinth_domain_executor NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE plinth_domain_verifier LOGIN NOSUPERUSER NOBYPASSRLS;
-- Set a deployment-managed verifier secret; never use development passwords.
```

Fresh Compose and CI create local-only roles and apply the ordered migration.
`TEST_DOMAIN_DATABASE_URL` selects the verifier connection for integration tests;
the local fallback uses the development application's connection/password with
the verifier username. This is test setup, not production provisioning.

Ownership confirmation enables public metadata resolution for that hostname.
It does not issue a certificate, configure Cloudflare/custom-host routing,
register an OIDC callback or add a browser-session origin. Deployment must confirm
TLS/routing/provider configuration before its trusted `originForHub` adapter
approves a custom origin, and that adapter must reflect removal/revocation.
An HTTP `verified` flag and forwarded host headers cannot activate domains.

Production acceptance still requires real public DNS/TLS tests, ingress rate limits,
claim cleanup/quota and pagination, periodic ownership rechecks and a strategy for
domain transfers. Existing verified names remain reserved until explicitly removed
or revoked by an administrator. Automated certificate/provider orchestration and
new-host session provisioning remain to implement. Phase 0 external gates stay open.
