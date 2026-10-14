# Auth0 staging setup

Auth0 is the selected managed login provider. These steps are done by the
account owner in the Auth0 dashboard. The values they produce configure
`createManagedApplication`; see [authentication setup](authentication.md).
Auth0 has no South African region, so identity data is a cross-border transfer
that still needs its DPA and POPIA assessment (see the Phase 0 decision register).

## 1. Create the tenant

1. Sign up at <https://auth0.com> with a role-based email.
2. Create a tenant named, for example, `plinth-staging`, in the **EU** region.
   A tenant's region cannot be changed later. Use a separate tenant for
   production.

## 2. Create the API

Under Applications, APIs, create an API:

- Name: `Plinth API (staging)`.
- Identifier: `https://api.staging.plinth` (or similar). This becomes the access
  token audience; it is an identifier, never fetched.
- Signing algorithm: RS256.

Then in its settings:

- Set the access token profile to **RFC 9068**, so tokens carry `typ: at+jwt`,
  `aud` and `client_id`. Plinth's authenticator expects this profile by default.
- Keep token expiry at 3600 seconds or less; Plinth rejects older tokens.
- Leave offline access (refresh tokens) disabled.

## 3. Create the web application

Under Applications, create a **Regular Web Application** named
`Plinth Web (staging)`:

- Allowed Callback URLs: `https://<approved hub origin>/auth/callback`, one per
  origin. These exist only once staging has HTTPS ingress; leave empty until then.
- Advanced settings, OAuth: JSON Web Token signature algorithm RS256, and OIDC
  Conformant on.
- Advanced settings, Grant Types: **Authorization Code only**. Untick Implicit,
  Refresh Token and Client Credentials.
- Credentials: token endpoint authentication method **Client Secret (Post)**.

## 4. Connections and protection

- Under Authentication, Database, keep `Username-Password-Authentication` enabled
  for this application. Decide whether staging allows public sign-up or only
  invited testers.
- Disable social connections that use Auth0's shared development keys; add real
  ones later if needed.
- Under Security, Attack Protection, turn on brute-force and breached-password
  protection. Consider requiring MFA.
- **Do not enable automatic account linking** (Actions, rules or extensions that
  merge users by email). Plinth links identities itself, only after fresh
  sign-in, and never by email.

## 5. Values to record

| Value | Example | Handling |
| --- | --- | --- |
| Domain | `plinth-staging.eu.auth0.com` | Configuration |
| Issuer | `https://plinth-staging.eu.auth0.com/` (trailing slash) | Configuration |
| JWKS URL | `https://plinth-staging.eu.auth0.com/.well-known/jwks.json` | Configuration |
| API identifier (audience) | `https://api.staging.plinth` | Configuration |
| Web client ID | from the application | Configuration |
| Web client secret | from the application | **Secret.** Keep in a password manager, then AWS Secrets Manager. Never paste it into chat, commits, tickets or logs. |

## 6. Register the issuer in Plinth

A valid signature from an unregistered issuer cannot sign anyone in. Using the
migration role on the staging database, register the exact issuer string:

```sql
INSERT INTO identity.auth_issuers(issuer,enabled) VALUES('https://plinth-staging.eu.auth0.com/',true);
```

## 7. Acceptance still to record

Real sign-in, callback and `prompt=login` behaviour (used by account linking) are
verified against this tenant once staging has an HTTPS origin. Record the
tenant region, DPA acceptance and reviewer in the sub-processor register.
