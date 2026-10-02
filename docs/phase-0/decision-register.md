# Phase 0 decision and evidence register

| Gate | Current status | Required evidence | Owner |
|---|---|---|---|
| Payment split model | Pending | SA account/product eligibility, recurring splits, refunds, settlement exports and counsel assessment of actual flow | Product/finance/counsel |
| Option 2 fallback | Documented, not selected | Provider merchant onboarding and SaaS-only limits accepted | Product/finance |
| Video transfer path | Pending | Vendor locations/DPA, whole pipeline assessment, enterprise requirements | Privacy/product |
| Video fallback | Documented, not selected | Region, CDN and licence-service assessment | Engineering/privacy |
| POPIA baseline | Drafts prepared | Operator agreement, purpose schedule, retention matrix and breach runbook ready for counsel review | Privacy owner |
| Tenant isolation | Embedded SQL/HTTP checks pass | Full PostgreSQL 17 gate and CI run evidence | Engineering |
| Repository/CI baseline | Local scaffold prepared | Remote repository and hosted CI run when available | Engineering |
| Local environment | Embedded runner works | Docker/PostgreSQL network environment remains unavailable | Engineering |
| Staging | Not provisioned | Account/profile, isolated secrets, region and environment deployment evidence | Infrastructure owner |

Evidence records must include document location, date, actual account/product scope, reviewer and limitations. Do not mark a vendor approved from generic documentation alone.

Public sources verified 2 October 2026: [Paystack split-payment documentation](https://paystack.com/docs/payments/split-payments/), [Mux privacy controls](https://www.mux.com/docs/guides/ensure-data-privacy-compliance). These explain capabilities but do not close the account-specific/legal gates.

Phase 0 exit is pending until required external and full database evidence is attached. Engineering can continue vendor-neutral work while those decisions are collected.
