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

1. With `oidcConfiguration` supplied, `/h/{slug}/sign-in?view=member|join|admin|create-hub`
   redirects to the trusted provider. `/auth/callback` validates a one-use attempt,
   cookie binding, S256 PKCE, state, nonce and the signed ID token before resolving
   a global account and issuing the session. This server-side OIDC flow is separate
   from bearer API authentication. Real provider verification remains outstanding.
2. `POST /v1/hubs/{id}/session` exchanges the verified bearer for a persistent
   browser session. The Host and Origin must match that hub's approved origin.
   Its response gives a CSRF token and expiration; the opaque credential is only
   in a `__Host-plinth-session` Secure, HttpOnly, SameSite=Lax cookie with Path=/
   and no Domain attribute. Only its SHA-256 hash is stored in PostgreSQL.
3. The session is bound to both hub ID and origin. A cookie cannot be used to
   address another hub or from another host. Expiry is at most one hour and never
   later than the verified access/ID token expiry. No sliding extension or automatic
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

The configured application serves `/h/{slug}/join`, `/member`, `/admin` and `/create-hub` under
the same hub prefix. They require a valid session for that hub. Member/admin
screens require active membership; admin requires owner/admin role. The join
screen leaves optional consent unchecked; unchecked choices are not granted.
Members can save/revoke each per-hub purpose, and admins can save safe branding.
The creation screen requires a global session but no current hub membership;
the new hub and owner are created atomically. The existing session remains bound
to the original hub, so a new hub requires approved routing and sign-in.
Provider text is escaped, CSP permits only the platform's same-origin script,
and browser credentials never enter localStorage/sessionStorage.

`npm run dev` remains a health shell. There is no development token bypass or
public sample authenticator. Apply migrations 006–008 after 005 and provision the
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

## Hosted provider configuration

Build `oidcConfiguration` from trusted deployment settings using
[`openid-client` discovery](https://github.com/panva/openid-client/blob/main/docs/functions/discovery.md),
then pass it into `createManagedApplication` alongside the existing API auth settings:

```js
import * as oidc from 'openid-client';
const oidcConfiguration = await oidc.discovery(new URL(settings.issuer),
  settings.webClientId, {client_secret: settings.webClientSecret,
    id_token_signed_response_alg: 'RS256'});
const server = createManagedApplication({pool, authPool, auth: apiAuth,
  oidcConfiguration, originForHub});
```

This is a configuration example, not an activated provider account. Register an
exact `https://<approved-host>/auth/callback` redirect for every supported origin.
Use a confidential web client, its supported authentication method and managed
secret storage. Discovery and authorization/token/JWKS endpoints must use HTTPS;
S256 support and an asymmetric ID-token algorithm are required. The service
explicitly enables the library's
[signature verification](https://github.com/panva/openid-client/blob/main/docs/functions/enableNonRepudiationChecks.md).
Only `openid` is requested; no offline/refresh credential is retained.

Login attempts expire after ten minutes. PostgreSQL stores the state hash and
server-only nonce/verifier; the browser receives a Secure/HttpOnly/SameSite=Lax
`__Host-plinth-login` cookie. Consumption uses DELETE RETURNING so concurrent
callbacks cannot reuse an attempt. Failure requires starting sign-in again.
Callbacks use the trusted host origin, ignoring forwarded host headers; no Origin
header is required for this top-level provider redirect. Cookie-authenticated
API mutations still require Origin plus CSRF. Return paths are an allowlist,
not user-supplied URLs. Do not log callback query strings, codes or login payloads.

Schedule `AuthRepository.pruneLogins()` alongside session cleanup and set ingress
rate limits before exposing sign-in publicly. Real tenant setup, registered
redirects, HTTPS cookie delivery, provider-specific client authentication and
browser/device UAT remain external deployment acceptance work. The in-process
test provider supplies real signed ID tokens/JWKS and verifies PKCE; it is not a
production identity service.
