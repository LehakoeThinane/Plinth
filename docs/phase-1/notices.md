# Purpose-notice publication

The hub admin screen publishes optional consent purposes and revisions. Only
active owners/admins in that exact hub can publish or inspect publication history.
Organisation/company admin authority alone does not confer this permission.
Members and prospective joiners can still read the current notices through the
existing consent endpoint. No consent is preselected or granted by publication.

## API

`GET /v1/hubs/{hubId}/notices` returns the latest 100 publication snapshots to an
active hub admin. `PUT` accepts:

```json
{
  "purpose": "marketing",
  "noticeVersion": "2026-10-v2",
  "noticeText": "Your optional choice and its intended use...",
  "expectedVersion": "2026-10-v1"
}
```

For a new purpose, `expectedVersion` must be null. For a revision it must equal
the current version, and `noticeVersion` must be new and never previously used for
that hub/purpose. The current record and history update atomically. Duplicate
creation, stale updates, reused versions and serialization conflicts fail with
409; invalid input fails with 400. Refresh and review before retrying. Every edit
requires a fresh version, including corrections to notice text.

Purpose keys follow `[a-z][a-z0-9_]{0,63}`; versions have 1–100 characters and text
1–10,000 characters with non-whitespace content. Notice requests are bounded to
65,536 bytes to accommodate valid Unicode JSON; other request limits are unchanged.
Cookie mutations require exact Origin and CSRF. Role/company headers cannot
override verified identity, membership or session hub/host boundaries.

## Database and consent guarantees

Bootstrap `plinth_consent_executor NOLOGIN NOSUPERUSER NOBYPASSRLS` before applying
migration 010 after 009. It owns the audit trigger, has only required schema,
membership-read and publication insert/read grants, and owns no tables. Runtime
roles must not be members. Local/CI bootstrap creates it for fresh databases;
existing volumes need controlled role bootstrap and the ordered migration.

Current purpose writes use the application role with restrictive owner/admin RLS
policies. A guard rejects same-version edits or key changes; the history primary
key rejects version reuse. History has forced hub/admin RLS and no runtime insert,
update or delete grants. Its trigger records the verified caller, text and version
in the publication transaction. Preexisting current notices are imported with null
author/date because their original publication metadata is unknown; earlier notice
versions observed in consent events/decisions are imported and reserved too.
Unknown or conflicting historical publication text is marked null, not invented;
the original consent snapshots remain unchanged.

An older grant is inactive when its recorded version differs from the current
notice. Reusing an old version could resurrect that grant, so publication forbids
it. Consent capture locks the matching notice and audits that exact text. A
publication/consent race either commits the old snapshot before publication or
returns conflict; it never silently attributes agreement to different text.
Withdrawal remains possible after membership ends through the existing consent
route. Optional consent does not grant access, join hubs or reactivate membership.

## Remaining acceptance

This supplies a technical publication workflow, not approval of notice wording.
Real provider/TLS/browser-device UAT, notice retirement, full history pagination
and record-specific retention/deletion remain outstanding. History currently
returns the most recent 100 entries; the database retains all publications.
