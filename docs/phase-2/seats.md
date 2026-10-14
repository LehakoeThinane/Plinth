# Company seats

Companies hold seats for a product and give them to their own people (Flow B in
the design). Every seat is an ordinary entitlement with `source = 'seat'`, so
access is decided exactly as for a purchase. Migration 028.

## Where seats come from

| Source | Who | How |
| --- | --- | --- |
| Purchase | An active admin of the organisation, who is also a hub member | Buys a number of seats (1–1000) at a product's per-seat price through checkout. The signed payment webhook creates the seat pool. |
| Provider grant | The hub's owners/admins | Grant seats for a deal agreed and paid off the platform, with a required reference such as a PO or invoice number. No money moves. |

A company product's seats can only go to the company it belongs to. Seats are
for paid (`entitled`) products only.

## Assigning and taking back

- **Assign:** a company admin gives a seat to an active member of the
  organisation (`POST /v1/hubs/{hub}/seat-pools/{pool}/assignments` with
  `{userId}`). If that person is not yet a hub member they become an ordinary
  member, and someone who had left is brought back. This also works when the hub
  is closed to open joining, because the provider sold or granted the seats. A seat never creates staff,
  and never lifts a suspension (`member_suspended`). Assigning the same person
  again returns their existing seat.
- **Take back:** the company admin, or the hub's owners/admins, take a seat back
  (`DELETE .../assignments/{user}`). Access ends at once and the seat is free.
- **End a grant:** hub owners/admins end a provider grant
  (`POST /v1/hubs/{hub}/catalogue/seat-grants/{pool}/end`), for example when the
  contract ends. Every seat in it ends. Purchased seats end only through a refund.
- **Refund:** a full refund of a seat purchase ends the pool and every seat
  assigned from it, with reversing ledger entries as for any refund.

The provider cannot assign seats; only the company's own admins can.

## How the last seat is protected

Each pool row keeps a count of live seats. Assigning or taking back a seat
locks the pool row and updates the count in the same transaction. When two
admins assign at once, the later transaction cannot use its out-of-date view; it
fails to serialise and is retried on fresh data, then gets `no_seats_left`. A
database check (`assigned` between 0 and `seats`) is the final guard. A test
races two assignments for the last seat and expects exactly one to succeed.

## Security

Seat pools and assignments have no runtime grants. Everything goes through
`SECURITY DEFINER` functions owned by the no-login role `plinth_seat_executor`,
which check the caller's role themselves:

| Function | Allowed for |
| --- | --- |
| `app.grant_seats`, `app.end_seat_pool` | Hub owners/admins |
| `app.assign_seat` | Active admins of the pool's organisation |
| `app.revoke_seat` | Those admins, or hub owners/admins |
| `app.seat_overview` | A company admin for their organisation (pools, holders, and member names to assign to), or hub owners/admins for all pools |

The overview shows display names only. A company admin sees who holds the
company's seats, never anyone's own purchases. Seat orders are restricted at the
database too: an order of kind `seats` can only be created by an active admin of
the named organisation.

Audit: each pool records its source, reference, grantor and dates; each
assignment records who assigned it, who took it back and when. The design asks
for grants to be recorded in the ledger at zero value. The ledger only accepts
non-zero lines, so grants are recorded in the seat pool instead.

## Screens

- **Company seats** (`/h/{slug}/seats`, in the Account menu): for company admins.
  Shows each pool's seats in use, who holds them, and lets them give or take back
  seats. People who have left the organisation are flagged for review; their
  seat is not taken back automatically.
- **Manage hub → Company seats** (`/h/{slug}/admin/seats`): every company's
  pools, the grant form and End grant.
- Product pages show **Buy seats** for per-seat prices. The seat checkout asks
  which organisation and how many seats.

## Demo data

`npm run local` adds a R950 per-seat price to BE HEARD and Zoya's grant of 10
seats on the Absa programme (reference `ABSA-PO-2026-118`). Lerato, Absa's
admin, holds one of them. This is added to existing demo hubs too.

## Not yet built

Inviting a new employee by email straight from seat assignment (today the person
must already be an organisation member), seat reporting for company admins
(progress of seat holders), automatic review when someone leaves the company,
and moving seats between pools.
