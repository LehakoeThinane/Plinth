# Purpose-notice publication

The hub admin screen publishes optional consent purposes and revisions. Only
active owners/admins in that exact hub can publish or inspect publication history.
Organisation/company admin authority alone does not confer this permission.
Members and prospective joiners can still read the current notices through the
existing consent endpoint. No consent is preselected or granted by publication.

## API

`GET /v1/hubs/{hubId}/notices` returns notice history to an active hub admin,
newest first: publications (`kind: "published"`, with text) and retirements
(`kind: "retired"`), each with `actor` and `at`. Imported entries with an unknown
date sort last with `at: null`. Pages default to 50 entries (`limit` 1–100);
pass the returned `next` value as `before` for older entries. The cursor is
opaque; malformed cursors and limits return 400. The admin screen shows the
first page with an "Older entries" link. `PUT` accepts:

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

## Retiring a purpose

`POST /v1/hubs/{hubId}/notices/retire` with `{"purpose","expectedVersion"}`
retires the current version; a stale or already-retired version returns 409.
A retired purpose is no longer offered to members or joiners, existing grants
become inactive, and new grants are refused (409), while withdrawal still works.
Retirement keeps the version and text; the database stamps who retired it and
when, and appends the event to forced-RLS `compliance.notice_retirements` in the
same transaction. To offer the purpose again, publish a new version: that
reactivates it, and older grants stay inactive because their version differs.
A retired version can never be reused.

Migration 015 adds the retirement columns and history table, lets runtime set
only `retired_at` (the guard stamps `retired_by`), and extends the publication
guard, audit trigger and consent check. Retirement cannot be undone in place.
Apply it after 014 on existing databases. Downstream use of consent (for
example marketing sends) must check that the purpose is active as well as granted.

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
Real provider/TLS/browser-device UAT and record-specific retention/deletion
remain outstanding. The database retains all publications and retirements.
