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

## Not yet built

Video, audio and PDF assets with signed links, watermarking and stamping (Deep
dive 2); progress saving (`PUT /lessons/{id}/progress`); an access log of lesson
opens; a learner "my learning" view for navigating purchased products; and
rich text formatting.
