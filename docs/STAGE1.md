# Stage 1 foundation notes

Stage 1 covers startup, configuration, PostgreSQL/migrations, operational HTTP
contracts, documentation and packaging. It does not establish application-role
authorization, task graphs, inventory invariants or scale readiness.

## Implementation references

Installed Effect packages and vendored reference manifests are version 4.1.2.
Imports use npm packages; the reference tree remains read-only.

- `repos/effect/ai-docs/src/51_http-server/10_basics.ts`: HttpApi contracts,
  handler Layers and HTTP composition.
- `repos/effect/packages/effect/src/http/HttpRouter.ts`: route middleware provides
  request-scoped services; response transformations happen before transmission.
- `repos/effect/packages/effect/src/http-api/HttpApiSwagger.ts`: bundled Swagger
  assets, with no browser CDN requirement.
- `repos/effect/packages/sql/pg/src/PgClient.ts`: scoped pool, acquisition/connect
  bounds and per-connection startup parameters.
- `repos/effect/packages/sql/pg/src/PgMigrator.ts` and
  `repos/effect/packages/effect/src/sql/Migrator.ts`: transactional ordered
  migrations and ledger locking. A schema-specific transaction advisory lock
  additionally covers first schema/ledger creation; no process-local mutex is
  used. Schema dumps are disabled.

## Verification

Verified on 13 November 2026:

| Check | Result |
| --- | --- |
| `nix develop --command just check` | Passed type-checking, 21 unit/HTTP/startup tests and production build |
| `npm run test:integration` inside the Nix shell | 9 tests passed against an isolated PostgreSQL 16.16 instance under `/tmp` |
| Test cleanup | Zero generated test schemas remained after the suite |
| Missing `TEST_DATABASE_URL` with a development URL present | Integration command failed before connecting; no fallback |
| Database CLI smoke | Read-only check created zero schema objects; explicit migration applied the initial migration and inspection reported it |
| Compiled `dist/main.js` smoke | Real HTTP live/ready, generated OpenAPI, bundled docs and clean SIGTERM exit passed |
| Just listing and new recipe dry runs | Passed |
| SOPS availability | Version 3.13.3 available in the development shell |
| Docker build, Compose config validation and fresh startup/restart | Not run: Docker executable/daemon unavailable |
| Native NixOS PostgreSQL credentials and SOPS launch | Not run by the agent during this initial verification; private bundles were not yet supplied |

Subsequent owner-reported checks: Fabrizio reported working native database
connections, repo-local SOPS bundles in place, and completion of the curl smoke
checks. These were not independently rerun by the agent and do not establish a
native integration-suite pass or Docker qualification. The local bundle paths
are `secrets/dev.enc.env` and `secrets/test.enc.env`; private keys remain separately
managed.

The isolated PostgreSQL runs used a fresh data directory, explicit ephemeral
loopback port/socket and local trust authentication; they did not connect to or
modify the retained NixOS databases. Each temporary server was stopped afterward.
These runs establish SQL/transaction/lifecycle behavior, not native password
authentication or container packaging. No private secret files or keys were read.

The first integration run exposed a fixture lifetime bug (the cleanup pool closed
before schema cleanup). Cleanup now runs inside its pool's scope; the complete
suite was rerun successfully with zero leftover schemas.

Use `nix develop --command just check` for types, database-free tests and build.
Use an explicit SOPS test launch for `just test-integration`. HTTP unit tests
replace the database-health dependency; SQL/migration/lifecycle integration tests
use actual PostgreSQL and unique test-owned schemas.

Integration coverage includes repeated migrations and preserved sequence values,
deliberately overlapping migration runners on separate connections, rollback of
failed DDL/ledger writes, migration-before-listen, failure-before-listen, bounded
unavailable startup, readiness under pool exhaustion/recovery, actual HTTP,
SIGTERM shutdown, connection release, and subprocess restarts.

Docker Compose must be rehearsed independently on a Docker-capable machine:

```sh
docker compose -p sitetrack-stage1-review up --build --wait
curl --fail http://localhost:3000/health/ready
curl --fail http://localhost:3000/openapi.json
docker compose -p sitetrack-stage1-review exec db psql -U sitetrack -d sitetrack \
  -c "SELECT nextval('sitetrack.project_number_seq');"
docker compose -p sitetrack-stage1-review down
docker compose -p sitetrack-stage1-review up --wait
docker compose -p sitetrack-stage1-review exec db psql -U sitetrack -d sitetrack \
  -c "SELECT nextval('sitetrack.project_number_seq');"
docker compose -p sitetrack-stage1-review down
```

Choose a previously unused Compose project name for a fresh-volume rehearsal.
Check that the second sequence value continues rather than resetting. These
commands use only the isolated reviewer environment and preserve its volume.
Port 3000 must be available. Do not substitute native results for BOOT-01.
