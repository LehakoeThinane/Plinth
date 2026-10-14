# Lesson content

Lessons now carry written content. Opening a lesson follows the design's
Flow C: the access decision is made on fresh data, and only then is the content
read, in the same database snapshot, so content is never served on a decision
made from different data.

## Opening a lesson

`AccessService.open` resolves the lesson and its product inside the hub, checks
freshness (user access version and hub epoch), decides, then reads the lesson:

| Outcome | When | Returned |
| --- | --- | --- |
| `allowed` | Entitled buyer or seat holder, hub member for members-only products, anyone for free (`open`) products, hub staff | Title, summary, product, and the full text |
| `locked` | Not yet allowed, and the lesson shows a preview | Title, summary and product, with `reason` `join` or `purchase`; never the text |
| `not_found` | Company product and the caller is outside that company; unpublished lesson; no preview; another hub | Nothing |

Every ancestor's requirement applies; a lesson cannot be free inside a paid
product. The **preview** flag shows non-buyers a locked teaser (title and
summary) instead of a 404. It does not make the lesson free. Company lessons
need both an entitlement and membership of that company, and are hidden from
everyone else by the database boundary as well as by the decision. Revoking an
entitlement takes effect on the next open, because the access version changes.

## Routes

| Route | Who | Does |
| --- | --- | --- |
| GET `/v1/hubs/{hub}/lessons/{id}` | Anyone; bearer or session optional | JSON `allowed`/`locked`, or 404 |
| GET `/h/{slug}/lessons/{id}` | Anyone; session optional | Lesson page, locked page, or 404 |
| PUT `/v1/hubs/{hub}/catalogue/products/{id}/lessons/{lessonId}/content` | Hub owner/admin | Save `{body}`, up to 50,000 characters |

Signed-out visitors are treated as anonymous, so free lessons open without an
account. A supplied but invalid bearer token is rejected (401), never treated as
anonymous. A session for another hub returns 404. Product pages link the lessons
a visitor can see: every lesson of a free product, and preview lessons otherwise.
The admin product editor has an **Edit content** form per lesson.

## Storage and rendering

Migration 017 adds the `content` schema with `content.lesson_bodies`, keyed to
the lesson and its boundary through a composite foreign key. Forced RLS applies
the hub and company boundary policies; only active hub owners/admins can insert
or update, the database stamps `updated_by`/`updated_at`, and runtime can update
only the body column. The policy audit covers the table. Apply migration 017
after 016 on existing databases.

Text is plain: a blank line starts a paragraph and a single newline breaks a
line. It is escaped on output, so providers cannot add HTML or scripts.

## Progress

`PUT /v1/hubs/{hub}/lessons/{id}/progress` saves
`{baseRevision, furthestPosition, resumePosition, completed}` with a required
`Idempotency-Key` header (8–100 letters, digits, `-` or `_`). It needs a signed-in
learner (bearer, or cookie with Origin and CSRF) who can open the lesson now;
the decision and the write share one transaction, and otherwise it returns 404.

- Completion and furthest position only move forward; resume position can move
  back. A save whose `baseRevision` is stale keeps the stored resume position and
  returns `resumeConflict: true`, so the client can reconcile instead of
  believing its change applied.
- The learner/lesson row is locked for the merge. Concurrent saves conflict and
  are retried; a retry with the same key and payload returns the stored result,
  and the same key with a different payload returns 409.
- Positions are numbers from 0 to 10,000,000 (seconds for media; text lessons use
  1 for "read to the end"). Opening an allowed lesson includes the learner's
  progress.

Migration 018 adds `content.lesson_progress` and `content.progress_requests`
under hub, company-boundary and per-learner RLS. A trigger allows only one
revision forward at a time and refuses moving furthest position or completion
backwards; runtime cannot write another learner's rows. Apply it after 017.
Stored idempotency records are not pruned yet.

## My learning

`GET /v1/hubs/{hub}/learning` and the **My learning** page at `/h/{slug}/learning`
list, for an active member, the products they hold directly or through a tier,
plus free products they have started, with lessons completed, a percentage and a
Start/Continue link to the next unfinished lesson. Paid products disappear when
their entitlement is revoked or expires, even if progress exists. Company
products appear only for members of that company. It is a navigation aid; each
lesson is still access-checked when opened. Signed-in learners see a **Mark as
complete** button on lesson pages.

## Lesson-open log

Every time a signed-in person receives lesson content, `content.lesson_opens`
records who, which lesson, when and the browser's user-agent (truncated to 300
characters) as the device identifier. It is written in the same transaction as
the access decision, so it reflects exactly the content that was served. Locked
previews and signed-out opens of free lessons are not logged; there is no
person to trace. This is the investigation trail from Deep dive 2: with a
watermark it gives a provider a lead, but neither is proof on its own.

Only active hub owners/admins can read it: in the product editor under
**Recent lesson opens**, or through
`GET /v1/hubs/{hub}/catalogue/products/{id}/opens?limit=&before=` (newest first,
keyset paging by entry id). Company boundaries apply. Runtime credentials can
add only the caller's own entries and cannot update or delete any.

## Retention

`npm run records:expire` removes lesson opens older than
`ACCESS_LOG_RETENTION_DAYS` (1–3650, required, deliberately without a default:
the period is still to be confirmed in [retention.md](../retention.md)) and
idempotency records older than `IDEMPOTENCY_RETENTION_HOURS` (default 168,
minimum 24). It is a dry run that reports counts unless run with
`-- --apply`. It connects as `plinth_maintenance` (`MAINTENANCE_DATABASE_URL`), a
login that can only execute two retention functions owned by the non-login
`plinth_retention_executor`; it cannot read the tables, and application
credentials cannot run the functions. Bootstrap both roles before migration 019
on existing databases (local Compose and CI do this):

```sql
CREATE ROLE plinth_retention_executor NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE plinth_maintenance LOGIN NOSUPERUSER NOBYPASSRLS; -- managed secret in staging
```

## Not yet built

Video, audio and PDF assets with signed links, watermarking and stamping (Deep
dive 2); a schedule for the retention job; an offline queue in the browser; and
rich text formatting.
