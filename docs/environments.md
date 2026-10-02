# Environments

Local: compose.yaml binds PostgreSQL and Redis to localhost. Credentials are development-only. Run docker compose up -d, then copy .env.example to .env. PostgreSQL init scripts run only on a fresh volume; never delete a data volume to apply a migration. Subsequent migrations must be explicitly applied with the migration role.

Staging: not provisioned. Use isolated databases, buckets, credentials and auth configuration; synthetic test data only. Select region and processor contracts after Phase 0 evidence. Production keys and learner data must never enter staging. Production provisioning is not part of this local sprint.

CI: a fresh PostgreSQL 17 service applies the local role bootstrap and migration, installs locked dependencies, then runs unit and PostgreSQL integration tests. Missing database configuration is a test failure, not a skipped green check.

Secrets: environment/secret-manager injection; no committed production values. The application database role must be non-owner, non-superuser and unable to bypass RLS. Do not expose the pool or accept tenant/staff/company context directly from clients. Migration/support roles are separate and audited.

Audit events: actor, hub, organisation where applicable, action, target, timestamp, request id and external reference for seat grants. Do not log tokens, passwords, signed URLs or full message bodies.

Docker-free verification: npm run test:db:embedded applies both migrations in an ephemeral PGlite database and runs the same integration suite. It validates SQL/RLS and HTTP decisions but not independent concurrent connections or network PostgreSQL behaviour. npm run test:db against PostgreSQL 17 remains a separate required acceptance gate.

Current local state (2 October 2026): Docker Compose project plinth-phase0 is running healthy PostgreSQL 17 and Redis. Redis port is 16379; PostgreSQL port is 55432. The ignored .env is set up. Both migrations have been applied through fresh-volume initialisation. All 21 full database tests pass. Earlier Docker-unavailable notes are superseded by docs/phase-0/status.md.
