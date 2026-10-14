# Product catalogue

Providers package knowledge as products and list them on their hub's shelf
(core requirement 1). Products are authored by active hub owners/admins; the
shelf and product pages are public. Company products are delivered privately
and never appear on the shelf.

## Model

| Entity | Fields | Rules |
| --- | --- | --- |
| Product | type (`course`, `toolkit`, `programme`), title, summary, visibility (`public`, `members`, `company`), access mode (`open`, `members`, `entitled`), status | Starts as a draft. Type and visibility are fixed after creation. Each product owns a boundary; company products set the boundary's organisation. |
| Module | title, position | Ordered within a product. |
| Lesson | title, summary, position, preview flag, status | Belongs to a module of the same product and boundary (composite foreign key). |
| Plan | model (`once_off`, `subscription` with `month`/`year`, `per_seat`), amount in ZAR cents | Immutable: a price change retires the plan and adds a new one. Only retirement is allowed (`active` → `retired`). |

Amounts are integer cents between R1.00 and R1,000,000.00, shown as entered.
VAT treatment, invoices and checkout belong to the commerce slice. The
`marketplace_listed` flag is locked off for the model B launch.

## Publishing

`publish` puts the product live and publishes all its draft lessons in one
transaction; it can be called again to publish lessons added later. The
database refuses to publish a product without a lesson, or a paid (`entitled`)
public/members product without an active price. Once published, a product
cannot return to draft and its access mode is fixed: withdrawing a product
would currently also end buyers' access, so unpublishing and archiving wait for
the commerce slice. The last active price of a live paid product cannot be
retired; structure, price and publication changes lock the product row, so
concurrent retirements cannot both succeed.

## Company products

`visibility: company` with an existing `companyOrg` creates a product inside
that organisation's boundary. Its access mode is always `entitled` (access
comes from seat grants, a later slice) and the database refuses prices for it.
Row-level security hides it, its modules, lessons and plans from anyone outside
that organisation, except hub staff.

## Authority

Creating boundaries, products, modules, lessons and plans requires
`app.is_hub_admin()`, derived from membership rows in the same transaction.
Product and lesson updates use the existing staff policies; the repository sets
the staff flag only after that same admin check. Runtime can update only module
titles and plan status columns directly. The policy audit requires company
policies on the new tables.

## API

Public, no sign-in:

| Route | Returns |
| --- | --- |
| GET `/v1/hubs/{hub}/products` | Published public products with their lowest active price |
| GET `/v1/hubs/{hub}/products/{id}` | Product, outline of published lessons, active plans |
| GET `/h/{slug}` | Storefront with the shelf |
| GET `/h/{slug}/products/{id}` | Product page |

Hub owners/admins (cookie writes need Origin and CSRF):

| Route | Does |
| --- | --- |
| GET/POST `/v1/hubs/{hub}/catalogue/products` | List all products, including drafts; create a draft |
| GET/PATCH `/v1/hubs/{hub}/catalogue/products/{id}` | Full detail; edit title, summary, or access mode while draft |
| POST `.../{id}/modules` | Add a module `{title}` |
| POST `.../{id}/lessons` | Add a lesson `{moduleId, title, summary?, previewAvailable?}` |
| POST `.../{id}/plans` | Add a price `{model, amountCents, interval?}` |
| DELETE `.../{id}/plans/{planId}` | Retire a price |
| POST `.../{id}/publish` | Publish the product and its draft lessons |

Invalid input returns 400, rule violations and conflicts 409, and products the
caller cannot administer 404. Apply migration 016 after 015 on existing databases.

## Admin screens

Hub owners/admins see a **Products** link in the navigation. `/h/{slug}/admin/products`
lists every product, including drafts, with a create form;
`/h/{slug}/admin/products/{id}` edits details, adds modules, lessons and prices,
retires prices and publishes. Amounts are entered in rand and converted to
cents. Access mode is locked once published and hidden for company products,
which show their organisation instead of a price form. The screens use the
existing host/hub session with Origin and CSRF checks, recheck the owner/admin
role on every request, and escape all provider text. Signed-out visitors are
sent to sign-in; other members get 404.

## Not yet built

Lesson content and file uploads (assets), bundles,
members-only shelf views, unpublishing/archiving, reordering and deletion,
checkout and seat grants.
