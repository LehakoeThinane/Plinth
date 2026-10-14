# AWS staging account setup

These steps are done by the account owner in the AWS console. They need your
identity, payment card and MFA device, so they cannot be scripted from this
repository. Never create root access keys or IAM access keys for Plinth;
Terraform and the CLI use short-lived AWS IAM Identity Center (SSO) sessions.

The AWS CLI v2 and Terraform 1.10.5 are installed on the development machine.

## 1. Create and secure the management account

1. Sign up at <https://aws.amazon.com> with a shared, role-based mailbox you
   control (for example `aws-root@yourcompany.co.za`), not a personal address.
2. Choose the Basic support plan.
3. Secure the root user immediately: add MFA (a passkey or hardware key is
   best), create no access keys, and store the recovery details somewhere safe.
4. Under Account, set alternate contacts for billing, operations and security.

## 2. Turn on cost controls

1. In Billing and Cost Management, create a monthly cost budget, for example
   USD 100, with email alerts at 80% actual and 100% forecast spend.
2. Turn on Cost Explorer. Staging must stay within the agreed budget; the
   Terraform plan's cost estimate is reviewed before apply.

## 3. Create the organisation and the staging account

1. Open AWS Organizations and create an organisation. Keep the management
   account empty of workloads.
2. Create a member account named `plinth-staging` with its own role-based email.
   Production will later get a separate account; staging never holds real
   learner data or production vendor keys.

## 4. Enable the Cape Town region

`af-south-1` is an opt-in region and is disabled by default. Enable
**Africa (Cape Town)** under Account, AWS Regions for the `plinth-staging`
account (from Organizations, or signed in to that account), and wait until it
shows as enabled. Terraform cannot create anything there until it is.

## 5. Set up single sign-on

1. Enable IAM Identity Center for the organisation. Use Cape Town as its home
   region if it is offered; note the region you choose.
2. Create a user for yourself and require MFA for it.
3. Create a permission set `PlinthStagingAdmin` with a session duration of
   4 hours. Use the `AdministratorAccess` managed policy for the initial
   bootstrap only; it is tightened to the infrastructure role afterwards.
4. Assign your user and that permission set to the `plinth-staging` account.
5. Note the AWS access portal URL (the SSO start URL).

## 6. Connect this machine

Run these in a terminal; the browser opens for sign-in:

```powershell
aws configure sso --profile ekx-staging
# SSO session name: plinth   Start URL: <access portal URL>
# SSO region: <Identity Center home region>   Scopes: sso:account:access
# Account: plinth-staging   Role: PlinthStagingAdmin
# Default client region: af-south-1   Output: json
aws sts get-caller-identity --profile ekx-staging
```

The last command prints the staging **account ID**. Share that ID and the
Identity Center region; they are identifiers, not secrets. Do not share
passwords, MFA codes or any credentials. When the session expires, run
`aws sso login --profile ekx-staging`.

## 7. What happens next

With the account ID, engineering fills the ignored `infra/bootstrap/terraform.tfvars`
and produces a bootstrap plan for review. Nothing is applied until the plan and
its cost are reviewed. The remaining sequence is in [infra/README.md](../../../infra/README.md),
and evidence is recorded in [acceptance.md](acceptance.md).
