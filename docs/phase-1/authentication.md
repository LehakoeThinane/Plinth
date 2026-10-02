# Managed authentication and browser sessions

The adapter is ready for a managed provider issuing JWT access tokens for a
dedicated Plinth API audience. No provider account, hosted-login registration,
production issuer activation or TLS deployment is claimed.

## Composition and configuration

Use `createManagedApplication` in `src/app.js` with the normal `plinth_app` pool,
a separate `plinth_auth` pool, an `auth` configuration, and `originForHub(hubId)`.
The pools are owned/closed by the caller. The authentication pool has function
execution privileges only; it is not a table owner, superuser or RLS bypass role.
Migration 007 moves auth function ownership to `plinth_auth_executor`, a non-login,
non-superuser role without BYPASSRLS. Its explicit RLS policies and limited grants
permit only identity provisioning and session operations. Runtime roles are not
members of that role. Staging bootstrap must create all three roles before the
migrations and give the migration caller ownership-transfer capability.

`auth` requires an exact HTTPS `issuer`, dedicated API `audience`, and trusted
HTTPS `jwksUrl`. Allowed asymmetric algorithms default to RS256. The default
token type is `at+jwt`; providers using `JWT` need explicit provider-specific
access-token claim checks. ID tokens are not the default input to this adapter.
The JWT signature and claims are verified with the maintained
[jose jwtVerify API](https://github.com/panva/jose/blob/main/docs/jwt/verify/functions/jwtVerify.md).
Key URLs come only from deployment configuration, never token headers/claims.

An administrator must register and enable the exact issuer in
`identity.auth_issuers` after verifying its configuration. A valid signature from
a disabled/unregistered issuer cannot resolve or provision an account. Account
identity is `(issuer, subject)`; email, role, organisation and user ID claims are
not used to link identities or confer access. Account creation is atomic and
serialised per verified identity. It never silently joins a hub.

`originForHub` must return an administratively approved **exact HTTPS origin**
for the requested hub or null. It must reflect domain approval/revocation, not
infer authority from request headers. Requests must reach this application
through a trusted TLS ingress; public plaintext HTTP must not reach browser
session routes. Forwarded host headers are ignored. Domains, TLS certificates,
provider configuration and staging deployment still require real setup.

## Browser contract

1. The configured managed client obtains a Plinth API access token through its
   hosted sign-in flow. Its authorization-code/PKCE redirect, callback and token
   acquisition integration are still to build and validate against the selected
   provider. The application does not issue tokens or accept unsigned claims.
2. `POST /v1/hubs/{id}/session` exchanges the verified bearer for a persistent
   browser session. The Host and Origin must match that hub's approved origin.
   Its response gives a CSRF token and expiration; the opaque credential is only
   in a `__Host-plinth-session` Secure, HttpOnly, SameSite=Lax cookie with Path=/
   and no Domain attribute. Only its SHA-256 hash is stored in PostgreSQL.
3. The session is bound to both hub ID and origin. A cookie cannot be used to
   address another hub or from another host. Expiry is at most one hour and never
   later than the verified access token expiry. No sliding extension or automatic
   refresh is implemented. A new exchange replaces/revokes the prior cookie.
4. Cookie-authenticated mutations require an exact Origin and `x-csrf-token`.
   Explicit bearer-authenticated API clients use the bearer path. Malformed or
   invalid supplied bearer credentials cannot fall back to a cookie.
5. `DELETE /v1/hubs/{id}/session` deletes the stored session and expires the
   cookie. A copied pre-logout cookie then fails. Expired rows can be pruned using
   `AuthRepository.prune()`; scheduling that cleanup is an operational task.

Membership roles and suspension are always read from the database; sessions do
not cache provider/admin privileges. Provider logout/revocation does not currently
end an already-established Plinth session before its bounded expiry; backchannel
logout/global session revocation remain integration work. Do not log bearer or
cookie credentials or CSRF values.

## Application surfaces

The configured application serves `/h/{slug}/join`, `/member` and `/admin` under
the same hub prefix. They require a valid session for that hub. Member/admin
screens require active membership; admin requires owner/admin role. The join
screen leaves optional consent unchecked; unchecked choices are not granted.
Members can save/revoke each per-hub purpose, and admins can save safe branding.
Provider text is escaped, CSP permits only the platform's same-origin script,
and browser credentials never enter localStorage/sessionStorage.

`npm run dev` remains a health shell. There is no development token bypass or
public sample authenticator. Apply migrations 006–007 after 005 and provision the
restricted auth role separately on an existing database. Local/CI bootstrap
uses a development-only password; staging needs managed secrets/role provisioning.
The full database suite additionally requires `TEST_AUTH_DATABASE_URL`.

Tests use generated test keys, simulated trusted origins and native HTTP headers
for reverse-proxy boundary tests. This verifies code and PostgreSQL behaviour,
not real provider sign-in, DNS ownership, HTTPS cookie transport or device UAT.
Embedded tests model RLS/current-role privileges within one privileged session;
role membership is checked there, while actual login-level SET ROLE rejection
and concurrent independent provisioning connections require the full PostgreSQL
suite. CI runs both suites.
