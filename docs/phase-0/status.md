# Phase 0 acceptance status

Updated: 2 October 2026. Technical foundation complete locally; overall Phase 0 exit remains OPEN because external gate evidence and AWS staging do not exist.

## Verified technical deliverables

- Git repository initialised locally; lockfile, ignores and GitHub Actions workflow present. No remote repository or hosted CI run is claimed.
- Composition root, 11 module skeletons and documented ownership boundaries.
- Tenant transaction wrapper with validated context, parameterised local settings, repeatable-read snapshots and rollback/connection cleanup.
- Forced hub RLS, restrictive company policies, non-null inherited boundaries and provider-only catalogue mutation rules.
- Policy harness rejects missing/disabled RLS, missing company restrictions and additional permissive policies.
- HTTP 404, company isolation, expiry, cached revocation, company-membership removal and suspension regressions.
- Local PostgreSQL 17 and Redis running through Docker Compose project plinth-phase0. PostgreSQL is bound to 127.0.0.1:55432; Redis uses 127.0.0.1:16379 because Windows reserved the original port. Ignored .env contains development-only credentials.
- Runnable local health shell and module/driver architecture checks.

## Test evidence

npm run verify passed: 16 domain, 4 tenant-wrapper, 6 HTTP, 2 architecture and 21 embedded PostgreSQL checks (49 checks).

npm run test:db passed all 21 integration checks against network PostgreSQL 17. This repeats the SQL/HTTP acceptance cases on the actual database service, verifying the application role, pooled context cleanup and wire connection path rather than relying on the embedded adapter.

Redis PING returned PONG. Both Compose services reported healthy. CI is configured to run all local checks plus the full PostgreSQL suite; it has not run on a remote host.

## Review-ready deliverables

Draft operator agreement, sub-processor register, per-hub purpose/consent schedule, retention matrix and breach runbook are prepared. PSP/Mux/counsel request text and evidence templates are at docs/phase0/payments/ and docs/phase0/privacy/. Nothing has been sent externally.

## Gates that cannot be closed by local code

1. Written SA PSP capability confirmations and payments counsel opinion, or a documented approved fallback.
2. Written Mux responses/DPA and whole-pipeline POPIA assessment, or an assessed approved fallback.
3. AWS account/role/profile configuration and staging deployment evidence. ekx-staging is a proposed profile, not an existing one; infra/README.md specifies the required baseline.

The user confirmed that no approvals or staging account exist. Drafts and public documentation do not replace these answers. See decision-register.md and the acceptance templates for required evidence. No production payment/video integration is approved or provisioned.

## Handoff

Run npm run verify and npm run test:db for local gates. Run npm run dev for the health shell only; authenticated product API composition still requires a managed-auth adapter. Phase 1 vendor-neutral identity/tenancy work may proceed while the external gates are actioned. Later outbox, production auth, full application features and staging infrastructure remain outside this technical foundation.

## Final preparatory completion — 2 October 2026

Executable AWS Terraform is now prepared in infra/bootstrap and infra/staging. Both roots passed terraform init -backend=false and terraform validate using Terraform 1.10.5 in disposable Linux containers. HashiCorp-signed AWS 6.67.0 and Random 3.9.1 provider downloads generated committed-intent lockfiles. terraform fmt completed successfully. No AWS credentials, plan, apply or deployment were used. Infrastructure CI validates syntax/provider schema without credentials and never applies resources.

The staging baseline includes isolated subnets, application-only database/cache ingress, encrypted private PostgreSQL/Redis, TLS, managed secrets, protected/private asset storage and a restricted runtime role. Runtime has no RDS master-secret access and cannot list asset storage. The bootstrap state bucket is encrypted, versioned and protected from destruction; staging uses S3 native lockfiles. Account IDs, actual available engine versions/zones and globally unique bucket names remain required inputs.

All Phase 0 preparatory code, local technical verification and review-ready packs are complete. Overall Phase 0 acceptance remains OPEN, exclusively for actual account/deployment evidence and external payment/privacy decisions. Generic documentation, validated Terraform and draft review packs cannot establish those facts. User confirmation remains that no staging account/profile, PSP replies or legal assessments exist.
