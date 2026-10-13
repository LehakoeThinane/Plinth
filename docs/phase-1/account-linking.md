# Account linking

A global account can have several sign-in methods. Each method is a verified
`(issuer, subject)` pair in `identity.auth_links`; signing in with any of them
resolves to the same account. Linking is self-service, but it needs proof of
both sides: a recent browser session for the existing account, and a fresh
provider sign-in for the new method. Email, names and other claims are never
used to link or merge accounts.

## Routes

| Route | Operation |
| --- | --- |
| GET `/h/{slug}/account` | Account screen: sign-in methods, link/remove controls, recent changes |
| GET `/v1/hubs/{hub}/account/links` | Caller's sign-in methods and latest 50 changes |
| POST `/v1/hubs/{hub}/account/links` | Start linking with `{slug}`; returns the provider `location` and sets the login cookie |
| DELETE `/v1/hubs/{hub}/account/links` | Remove `{issuer, subject}` from the caller's account |

POST and DELETE need a cookie session for that hub with exact Origin and CSRF.
Bearer-only callers receive `403 browser_session_required`. Both need a session
established within the last 10 minutes; otherwise they return
`403 reauthentication_required` and the screen offers "Sign in again".
A session exchanged from a bearer token counts from the exchange, not from the
token's original sign-in.

## Linking flow

1. Starting stores a login attempt carrying the session's user and session hash,
   and sends the user to the provider with `prompt=login`.
2. The callback is validated like any hosted sign-in (one-use state, cookie
   binding, S256 PKCE, nonce, signed ID token). It must also present the same
   live session that started the attempt; a different, replaced or missing
   session fails before the code exchange.
3. `app.link_auth_identity` re-checks the session in the database (live and
   established within 20 minutes, covering the 10-minute start window plus the
   attempt lifetime) and the enabled issuer, then returns:
   - `linked`: the identity was attached and a `linked` event recorded;
   - `unchanged`: it was already linked to this account;
   - `conflict`: it belongs to another account and nothing changed.
4. The browser returns to `/h/{slug}/account?link=<outcome>`. The callback never
   provisions an account or replaces the existing session.

Merging two existing accounts is not supported. If someone first signed in with
the second method, that created a separate account, and linking reports
`conflict`. Resolving that needs a future, separately reviewed merge or
support process.

## Removing a method

`app.unlink_auth_identity` requires a live session established within the last
10 minutes and a method owned by the caller (otherwise 404). The last method can
never be removed (409); a per-account advisory lock serialises concurrent
removals. Removal deletes every other session of the account, because sessions
do not record which method created them. The current session continues until its
normal expiry, even if it was established with the removed method.

## Database boundary

Both functions are `SECURITY DEFINER` and owned by `plinth_auth_executor`
(non-login, no BYPASSRLS). Only `plinth_auth` may execute them. Linking takes the
account lock, then the same per-identity lock used by first-time provisioning, so
a concurrent first sign-in and link cannot both claim an identity.

`identity.account_events` records `linked`/`unlinked` with issuer, subject and
time, under forced RLS. Users can read only their own events; only the executor
can insert, and no role can update or delete them through the application. The
policy audit fails if the table's scope policy is removed.
Migration 013 also recreates `app.read_auth_session` so sessions report
`created_at`. Apply it after 012 on existing databases; fresh Compose volumes
and CI apply it automatically.

## Remaining work

Real-provider verification of `prompt=login` behaviour and provider-side
account-linking settings; notifying users of sign-in method changes; account
merge or support recovery for conflicts; retention of account events; and
browser/device UAT.
