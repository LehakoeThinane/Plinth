# Staging acceptance record

Status: OPEN. ekx-staging is a proposed name, not an existing profile. No infrastructure is provisioned.

Required evidence: account/profile identity; reviewed IaC plan; state bootstrap and locking; isolated af-south-1 database/cache/storage configuration; encryption and secret separation; application network connectivity; migration and RLS/HTTP smoke checks; synthetic-data policy; backup/restore evidence; budget/owner; and no production vendor credentials.

Preparation completed: executable Terraform roots now exist at infra/bootstrap/ and infra/staging/. The state bucket uses encryption, versioning, Block Public Access and native S3 state locking for staging. Configuration includes private PostgreSQL/Redis, TLS, managed secrets, private asset storage and restricted runtime permissions. Syntax/provider validation evidence is recorded in docs/phase-0/status.md. No AWS plan/apply or cloud resources are claimed.

Terraform preparation validation: both bootstrap and staging passed Terraform 1.10.5 provider-schema validation on 2 October 2026, with backend disabled and no AWS account access. Provider lockfiles are saved. AWS plan/apply, regional availability, price, deployed connectivity and restore evidence remain pending.
