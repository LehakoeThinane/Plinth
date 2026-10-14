# Enquiries

A person or company asks a provider about bespoke work, which opens a
conversation with the provider (core requirement 3). Negotiation and contracting
happen off the platform. The conversation tables are shared with direct and
group messaging (requirement 7), which builds on them.

## Who can do what

| Person | Can |
| --- | --- |
| Any signed-in account, including prospects who have not joined the hub | Send an enquiry; read and reply in their own enquiries |
| Someone enquiring for a company | Name that company only if they are an active member of it |
| Suspended hub member | Nothing: cannot enquire or send |
| Hub owners/admins (the provider) | See every enquiry in an inbox with unread counts; reply; set status |
| Anyone else, including facilitators and other members | Nothing: 404 |

Hub owners/admins can read **enquiry** conversations only. Future direct and
group conversations between members will not be readable by hub staff.

## Conversation rules

- Messages are plain text (up to 5,000 characters), escaped on output.
- Each message carries the client's own id; resending with the same id returns
  the original message instead of posting twice.
- History loads backwards from the latest message (`before`, `limit`); each page
  is returned oldest first. Order and read state use a database sequence number,
  not timestamps: wall clocks can step under time synchronisation, which made a
  new message look already read (migration 024). `before` is the `seq` of the
  oldest message shown. Two sends committing out of order in the same
  conversation can still be marked read together; acceptable for this use.
- A provider's first reply moves an `open` enquiry to `in_discussion`. Providers
  can set `open`, `in_discussion` or `closed`. A closed enquiry is read-only for
  everyone until reopened.
- Opening a thread marks it read; inbox unread counts are per person.

## Database protection

Migration 022 adds the `messaging` schema (conversations, participants, messages,
enquiries) under forced hub RLS plus restrictive policies that rely on definer
functions:

- `app.can_read_conversation`: participant, or hub owner/admin for enquiry
  conversations only.
- `app.can_write_conversation`: readable, not suspended, enquiry not closed.
- `app.is_unclaimed_enquiry`: an enquiry may claim only a brand-new enquiry
  conversation that nobody has joined.
- `app.is_enquiry_requester`: a requester may join only the conversation of
  their own enquiry; providers join as `provider` only when they can read it.

Together these stop anyone joining, claiming or writing into someone else's
conversation even if they learn its id. Only owners/admins can change status.
Apply migration 022 after 021 on existing databases.

## Routes

| Route | Does |
| --- | --- |
| POST `/v1/hubs/{hub}/enquiries` | Send `{subject, need, requesterOrg?}` |
| GET `/v1/hubs/{hub}/enquiries` | Inbox (providers) or my enquiries, with unread counts |
| GET/PATCH `/v1/hubs/{hub}/enquiries/{id}` | Enquiry with latest messages; set `{status}` (providers) |
| GET/POST `/v1/hubs/{hub}/conversations/{id}/messages` | History; send `{body, clientId}` |
| PUT `/v1/hubs/{hub}/conversations/{id}/read` | Mark read |

Pages: `/h/{slug}/enquiries` (inbox or my enquiries, with the enquiry form) and
`/h/{slug}/enquiries/{id}` (thread). The storefront links to them, and signing
in can return there.

## Not yet built

Live delivery over WebSocket and offline email notifications (need the realtime
gateway, worker and an email provider), attachments, direct and group
conversations (requirement 7), and rate limits against enquiry spam.
