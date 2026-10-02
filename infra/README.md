# Cape Town staging infrastructure

Terraform configuration is prepared, not deployed. Profile ekx-staging and a verified AWS account still need to be supplied. No production payment/video integration is included.

## Layout

- bootstrap/: encrypted/versioned/block-public-access S3 state bucket and KMS key with deletion protection.
- staging/: isolated VPC/subnets, security groups, private PostgreSQL 17 with TLS and managed master secret, encrypted authenticated Redis, private encrypted assets bucket, separate application secret placeholder and restricted ECS task role.
- staging/backend.hcl.example: remote S3 state with native lockfile locking.
- terraform.tfvars.example: non-secret account/region version inputs; replace placeholders after account validation.

The RDS master secret is never granted to runtime. Application credentials must be generated for the non-owner, non-bypass-RLS application role after migrations and placed in its dedicated secret. Redis credentials are generated and stored in Secrets Manager; Terraform state contains sensitive values and must remain restricted/encrypted. The runtime role cannot list the asset bucket. Object access under hubs/ still requires application entitlement checks.

## Validation without an AWS account

Run terraform fmt -check -recursive infra. In each of bootstrap and staging run terraform init -backend=false followed by terraform validate. CI performs only these checks. They validate syntax/provider schema, not account eligibility, regional engine availability, price or deployability.

## Deployment handoff

1. Configure ekx-staging through AWS SSO and verify the account ID. Obtain an isolated staging account/role and budget.
2. Copy bootstrap/terraform.tfvars.example to ignored terraform.tfvars; fill the verified account and globally unique state bucket name. Review a bootstrap plan before apply.
3. Protect the bootstrap's initial local state and migrate it to approved encrypted storage; do not commit state. Restrict state bucket/KMS access to the infrastructure role, including the S3 lockfile permissions.
4. Copy staging/backend.hcl.example to ignored backend.hcl and fill the actual bootstrap outputs. Native S3 locking requires Terraform 1.10 or later. Initialise the remote backend only once these inputs exist.
5. Fill ignored staging/terraform.tfvars with actual available zones, PostgreSQL 17 and Redis versions, verified account and unique asset bucket. Confirm the chosen instance types are available in af-south-1.
6. Review the saved staging plan and estimated costs before apply. Protected database/storage resources cannot be casually destroyed. Before any intended teardown, resolve final snapshot names and backups explicitly.
7. Attach an approved application or SSM/tunnel network path to the application security group. This baseline intentionally has no public database, internet gateway, NAT, compute service or ingress endpoint. Supply private access/endpoints required for Secrets Manager, S3 and logs when the application service is deployed; do not open database access publicly for CI.
8. Apply migrations using the migration role, provision the restricted application secret, then run RLS/HTTP staging smoke tests and a restore rehearsal with synthetic data.

No plan/apply is attempted until the AWS profile/account exists. The staging acceptance record is docs/phase0/staging/acceptance.md. Whole-pipeline processor/residency review remains independent of these region settings.

References: [S3 state and lockfile permissions](https://developer.hashicorp.com/terraform/language/backend/s3), [RDS managed password option](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/db_instance).
