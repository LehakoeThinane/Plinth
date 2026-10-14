# Community

Members discuss in spaces, and companies get private spaces for their own people
(core requirement 6). Hub owners/admins create spaces and moderate reports.

## Spaces and access

| Visibility | Who can read and post | Others |
| --- | --- | --- |
| `hub` | Active hub members | Not listed (404) |
| `tier` | Members whose active tier lists the space as a benefit | Listed as locked ("included in a membership tier"); no posts |
| `company` | Active members who belong to that organisation | Not listed; 404, never a hint that it exists |

Hub staff can read every space. Each space owns a boundary like a product does;
company spaces set the boundary's organisation, so row-level security hides the
space and all its posts, comments, reactions and reports from outsiders.

Every read and write goes through `AccessService.inSpace`, which makes the space
decision and runs the operation in the same transaction. A suspension, an ended
membership or a lapsed tier stops reading and posting at once. Archived spaces
return 404 to members and are read-only for staff. Community needs a signed-in
person; signed-out visitors are sent to sign-in.

## Contributions

- **Posts** (up to 10,000 characters) and **comments** (up to 5,000) are plain
  text, escaped on output. The feed is newest first with keyset paging.
- **Reactions** (`like`, `insightful`, `thanks`) are idempotent: repeating one
  changes nothing; removing one is a separate call.
- **Deleting**: authors can remove their own visible post or comment. Nobody can
  edit a body after posting. The database allows authors only the
  visible → removed change on their own rows.
- Inserts require the database to see an active membership and the caller as
  author, in addition to the decision.

Authors appear as "You" or a short account reference until hub profiles exist.

## Reports and moderation

Members report a post or comment with a reason; repeating a report on the same
target counts once. Hub owners/admins see open reports at
`/h/{slug}/admin/community` and resolve them as:

| Action | Effect |
| --- | --- |
| `dismiss` | Content stays |
| `hide` | Content is hidden from the feed |
| `remove` | Content is removed |
| `suspend` | Content is removed and the author's hub membership is suspended |

`app.resolve_report` applies the content change, any suspension and the
resolution of every open report on that target in one transaction. It runs as the
non-login `plinth_community_moderator`, whose only membership authority is
suspending ordinary members; owners, admins and staff cannot be suspended this
way, and moderators cannot suspend themselves. Suspension raises the member's
access version, so cached access ends immediately.

## Routes

Members (bearer or cookie session with Origin and CSRF):

| Route | Does |
| --- | --- |
| GET `/v1/hubs/{hub}/spaces` | Spaces I can see, with `allowed` or `locked` |
| GET/POST `/v1/hubs/{hub}/spaces/{id}/posts` | Feed (`before`, `limit`); start a post `{body}` |
| GET/DELETE `/v1/hubs/{hub}/posts/{id}` | Post with comments; delete my post |
| POST `/v1/hubs/{hub}/posts/{id}/comments` | Comment `{body}` |
| PUT/DELETE `/v1/hubs/{hub}/posts/{id}/reactions/{kind}` | Add or remove a reaction |
| DELETE `/v1/hubs/{hub}/comments/{id}` | Delete my comment |
| POST `/v1/hubs/{hub}/reports` | Report `{targetType, targetId, reason}` |

Owners/admins: GET/POST `/v1/hubs/{hub}/catalogue/spaces`, PATCH
`.../catalogue/spaces/{id}` (title, description, `active`/`archived`), GET
`.../catalogue/reports?status=`, POST `.../catalogue/reports/{id}/resolve`
`{action}`. Pages: `/h/{slug}/community`, `/h/{slug}/community/spaces/{id}`,
`/h/{slug}/community/posts/{id}` and `/h/{slug}/admin/community`.

## Storage

Migration 021 adds the `community` schema (spaces, posts, comments, reactions,
reports) under forced hub and company-boundary RLS, author and admin policies, a
contribution guard trigger and the moderation function. Bootstrap
`plinth_community_moderator NOLOGIN NOSUPERUSER NOBYPASSRLS` before applying it
after 020 on existing databases (local Compose and CI do this).

## Not yet built

Live updates and notifications (need the realtime gateway shared with messaging),
invite-only private groups, hub profiles with display names, post editing, rate
limits, and retention of removed content.
