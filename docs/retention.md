# Retention matrix skeleton

Draft for legal/accounting review. No statutory period has been assumed.

| Records | Purpose | Trigger | Period | Disposal | Hold owner |
|---|---|---|---|---|---|
| Hub membership and consent evidence | Access and purpose accountability | Membership ends / purpose ends | To confirm | Revoke access; delete/minimise hub-only identity | Privacy owner |
| Global identity and auth links | Global account | Global deletion request | To confirm | Disable sessions; unlink providers; delete/minimise PII | Privacy owner |
| Orders, ledger and invoices | Accounting and statutory evidence | Applicable financial event | To confirm per law | Retain required fields; restrict identity mapping | Finance |
| Posts, comments and own messages | Community, conversation and moderation | Deletion request / retention expiry | To confirm | Delete or redact author/content and attachments as appropriate | Privacy/moderation |
| Seat grants and assignments | Enterprise audit | Grant/assignment ends | To confirm | Minimise identity, retain justified reference | Enterprise operations |
| Access and security logs | Investigation | Logged event | To confirm, bounded | Expire logs and device identifiers | Security |
| Stamped document copies | Licensed delivery | Access ends / deletion request | To confirm | Delete copies and cached variants; minimise metadata | Content operations |
| Backups | Recovery | Backup creation | To confirm | Scheduled expiry; replay deletion tombstones on restore | Operations |

A hub deletion cannot alter another hub's user data. Global deletion must also cover storage, search, queues, caches and subprocessors. Pseudonymisation is not a guarantee of anonymity. Legal holds need recorded purpose, scope, reviewer and expiry/review date. Jobs must be idempotent and auditable. Downloaded copies on learners' devices cannot be recalled.
