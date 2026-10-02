# Phase 0 gate packs

These are created files, not proposed paths. No external messages have been sent.

- Payments request text and evidence checklist: payments/requests.md and payments/acceptance.md.
- Mux/privacy request text and evidence checklist: privacy/requests.md and privacy/acceptance.md.
- AWS staging acceptance record: staging/acceptance.md. Executable Terraform is in infra/bootstrap and infra/staging; infra/README.md explains validation and deployment.
- Operator agreement, sub-processors, purpose/consent schedule and breach runbook: docs/phase-0/.
- Record-specific retention draft: docs/retention.md.
- Technical verification and overall exit status: docs/phase-0/status.md.

## Exit evidence

Payments: written account-specific PSP capability answers and payments counsel assessment, or an accepted fallback decision with its limitations.

Privacy: written vendor responses/DPA and South African privacy assessment covering media, viewer/device data, analytics and the whole delivery/DRM path, or an assessed fallback accepted by the buyer.

Staging: actual AWS profile/account identity, reviewed plan, provisioning and migration evidence, private access path, database/cache health and RLS/HTTP smoke tests.

No code change can substitute for these external facts. The technical foundation and prepared gate packs are complete; Phase 0's external decisions remain pending until evidence is supplied.
