# Library

Providers publish library content with a visibility (core requirement 5). This
first slice supports **articles**; podcasts and videos need protected media
storage and arrive with the assets work.

## Visibility and access

Library items go through the same access decision as lessons, so membership,
suspension, tier benefits and entitlements behave identically:

| Visibility | Who can read it | Others see |
| --- | --- | --- |
| `public` | Anyone, signed out included | — |
| `members` | Active hub members (and staff) | Locked preview, reason `join` |
| `tier` | Members whose active tier lists the item as a benefit | Locked preview, reason `tier` (or `join` if not a member) |
| `entitled` | Members who hold the linked product, directly or through a tier | Locked preview, reason `purchase` with the product (or `join` if not a member) |

Every published item can be browsed, so locked results always show a preview
(title, summary, visibility, topics), never the text. Suspended members get 404.
Archived items return 404 to everyone except hub staff. A buyers-only item must
link to a paid (`entitled`) product that is not company-private; it stays out of
listings and closed until that product is published. The database rejects
linking a company product even when the caller's row-level security would hide
it, because the guard trigger runs with definer rights.

Tier visibility depends on tier benefits (`access.tier_benefits`), which the
membership-tiers slice will let providers configure.

## Routes

| Route | Who | Does |
| --- | --- | --- |
| GET `/v1/hubs/{hub}/library?topic=&before=&limit=` | Anyone | Published previews, newest first, keyset-paged, filterable by topic |
| GET `/v1/hubs/{hub}/library/{id}` | Anyone; identity optional | `allowed` with text, `locked` preview, or 404 |
| GET `/h/{slug}/library`, `/h/{slug}/library/{id}` | Anyone | Library and item pages |
| GET/POST `/v1/hubs/{hub}/catalogue/library` | Hub owner/admin | List all items; create a draft |
| GET/PATCH `/v1/hubs/{hub}/catalogue/library/{id}` | Hub owner/admin | Read; edit title, summary, text, visibility, product, topics |
| POST `.../{id}/publish`, `.../{id}/archive` | Hub owner/admin | Publish, or archive (items never return to draft) |

Admin screens are at `/h/{slug}/admin/library` (list and create) and
`/h/{slug}/admin/library/{id}` (editor), linked from the admin navigation. The
storefront header links to the public library. Text is plain paragraphs and is
escaped. Topics are up to five lowercase words joined by hyphens.

## Storage

Migration 020 adds the `library` schema with `library.items` under forced hub
RLS, admin-only insert/update policies, column-limited runtime updates and a
guard trigger for topics, company products, fixed identity and status changes.
Apply it after 019 on existing databases.

## Not yet built

Podcasts and videos (need media storage), configuring tiers and their benefits
(membership-tiers slice), and logging library opens.
