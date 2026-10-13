# Phase 0 decision and evidence register

| Gate | Current status | Required evidence | Owner |
|---|---|---|---|
| Payment split model | Pending | SA account/product eligibility, recurring splits, refunds, settlement exports and counsel assessment of actual flow | Product/finance/counsel |
| Option 2 fallback | Documented, not selected | Provider merchant onboarding and SaaS-only limits accepted | Product/finance |
| Video transfer path | Pending | Vendor locations/DPA, whole pipeline assessment, enterprise requirements | Privacy/product |
| Video fallback | Documented, not selected | Region, CDN and licence-service assessment | Engineering/privacy |
| POPIA baseline | Drafts prepared | Operator agreement, purpose schedule, retention matrix and breach runbook ready for counsel review | Privacy owner |
| Tenant isolation | Verified | Embedded and full PostgreSQL 17 suites pass locally and in hosted CI | Engineering |
| Repository/CI baseline | Verified | GitHub remote `LehakoeThinane/Plinth`; foundation and infrastructure workflows pass on `dev` pushes and PRs | Engineering |
| Local environment | Verified | Docker Compose PostgreSQL 17 and Redis healthy; full suite re-run 13 October 2026 | Engineering |
| Login provider | Auth0 selected (EU region), 13 October 2026 | DPA accepted; POPIA cross-border transfer assessment for identity data; real sign-in on staging. Amazon Cognito in Cape Town was the documented SA-resident alternative | Product/privacy |
| Staging | Not provisioned; account setup steps prepared | Account/profile, isolated secrets, region and environment deployment evidence. See docs/phase0/staging/aws-account-setup.md | Infrastructure owner |

Evidence records must include document location, date, actual account/product scope, reviewer and limitations. Do not mark a vendor approved from generic documentation alone.

Public sources verified 2 October 2026: [Paystack split-payment documentation](https://paystack.com/docs/payments/split-payments/), [Mux privacy controls](https://www.mux.com/docs/guides/ensure-data-privacy-compliance). These explain capabilities but do not close the account-specific/legal gates.

Phase 0 exit is pending until required external evidence is attached; the database and CI evidence is now in place. Engineering can continue vendor-neutral work while those decisions are collected.
