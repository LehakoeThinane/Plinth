# Membership tiers

A hub offers zero, one or many ranked membership tiers, each unlocking chosen
products, community spaces and library items (core requirement 8). This slice
covers setting tiers up and showing them; **subscribing** needs the payment
provider decision and is not built. Holding a tier is an `access.entitlements`
row of kind `tier`, which subscriptions will create.

## Tiers

| Field | Rules |
| --- | --- |
| Name, description | Up to 80 and 2,000 characters |
| Rank | 1–100, unique among tiers still on offer; orders upgrades and downgrades |
| Price | ZAR cents (R1.00 – R1,000,000.00) per `month` or `year` |
| Status | `draft` → `published` → `archived`; never back to draft, archived stays archived |

The price and billing period are fixed once a tier is published, because
subscribers will hold that price; offer a new tier to change it. An archived
tier frees its rank.

## Benefits

| Benefit | Must be |
| --- | --- |
| Product | A paid (`entitled`) product, never company-private |
| Community space | A `tier` space |
| Library item | A `tier` or buyers-only item |

`access.tier_benefits` gained a `target_type` and a foreign key to the tier. A
definer-rights trigger checks every benefit against the real item, even ones the
caller's row-level security would hide. Adding or removing a benefit raises the
hub's access epoch, so cached decisions refresh on the next request: a tier
holder gains or loses access immediately. These benefits are what the existing
lesson, library and community decisions already honour.

## Routes

| Route | Who | Does |
| --- | --- | --- |
| GET `/v1/hubs/{hub}/tiers`, `/h/{slug}/membership` | Anyone | Published tiers by rank with their live benefits ("Subscriptions open soon") |
| GET/POST `/v1/hubs/{hub}/catalogue/tiers` | Owner/admin | List; create a draft `{name, description, rank, amountCents, interval}` |
| GET/PATCH `.../catalogue/tiers/{id}` | Owner/admin | Tier, benefits and eligible items; edit |
| POST `.../catalogue/tiers/{id}/publish` or `/archive` | Owner/admin | Change status |
| POST `.../catalogue/tiers/{id}/benefits`, DELETE `.../benefits/{targetId}` | Owner/admin | Add `{targetType, targetId}` or remove a benefit |

Admin screens are at `/h/{slug}/admin/tiers` and `/h/{slug}/admin/tiers/{id}`;
the storefront header links to **Membership**.

## Storage

Migration 023 adds the `commerce` schema with `commerce.tiers` (forced hub RLS,
admin-only writes, a guard trigger for drafts, fixed prices and statuses) and the
benefit changes above. Apply it after 022 on existing databases.

## Not yet built

Subscribing, renewals, upgrades/downgrades and cancellations (payment provider),
complimentary tier grants by providers, and per-tier member counts.
