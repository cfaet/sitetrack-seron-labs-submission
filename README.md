# SiteTrack

Construction project and materials-tracking backend, using TypeScript, Effect 4,
Node.js, and PostgreSQL. See [SPEC.md](SPEC.md) for the implementation baseline
and staged acceptance criteria.

Stage 1 implements the HTTP service, PostgreSQL pooling and startup migrations,
health endpoints, generated OpenAPI/Swagger documentation, and foundation tests.
Authentication and project/task/inventory endpoints come in later stages.

## Reviewer startup

```sh
docker compose up
```

This builds the API and starts PostgreSQL without Nix, Just, SOPS, or copying an
environment file. Open <http://localhost:3000/docs> and
<http://localhost:3000/openapi.json>. The first build downloads dependencies and
images. The pinned images are Node.js `24.22.3-bookworm-slim` and PostgreSQL
`16.16-bookworm`.

The Compose database and role are both `sitetrack`, with the public password
`sitetrack_demo_only`. These are demonstration credentials for an isolated local
environment, never your native development credentials. PostgreSQL has no
published host port; the API is published only on `127.0.0.1:3000`.

```sh
docker compose exec db psql -U sitetrack -d sitetrack \
  -c "SELECT current_database(), current_user, current_setting('server_version');"
docker compose down
```

`down` preserves the named database volume. Subsequent startup applies only
pending migrations and preserves data and sequence values. There are no reset
or volume-deletion recipes. See [foundation notes](docs/STAGE1.md) for verification
evidence and remaining environment checks; Docker execution must be verified
separately from native PostgreSQL tests.

## Local development

Enter the optional Nix development shell:

```sh
nix develop
```

Verified shell versions: Node.js 24.22.2, npm 11.19.1, Just 1.59.0,
PostgreSQL client 16.16, curl 8.23.0, and SOPS 3.13.3. The existing NixOS-managed development
server reports PostgreSQL 16.15. The shell supplies database tools; it does not
start or configure PostgreSQL. `flake.lock` pins the nixpkgs revision used by
the shell.

Install the locked npm dependencies with `npm ci`. Without Nix, provide Node.js
24 and npm directly; Just is optional. TypeScript, tsx, and Vitest come from the
project's npm dependencies.

## Commands

Run commands from the repository root. `just` or `just --list` lists the recipes.

| Just | Equivalent npm command | Behavior |
| --- | --- | --- |
| `just dev` | `npm run dev` | Watch application source |
| `just typecheck` | `npm run typecheck` | Check source, tests, and Vitest configuration |
| `just build` | `npm run build` | Compile application source to `dist/` |
| `just start` | `npm start` | Run previously built output |
| `just test` | `npm test` | Run database-free unit/HTTP tests once |
| `just test-watch` | `npm run test:watch` | Watch database-free tests |
| `just check` | `npm run check` | Type-check, test, then build; stop on failure |
| `just test-integration` | `npm run test:integration` | Run real PostgreSQL tests with explicit test configuration |
| `just db-check` | `npm run db:check` | Read-only development database inspection |
| `just db-test-check` | `npm run db:test:check` | Read-only test database inspection |
| `just db-migrate` | `npm run db:migrate` | Apply pending development migrations explicitly |
| `just compose-up` | `docker compose up --build` | Build and start reviewer services |
| `just compose-down` | `docker compose down` | Stop services, preserving volumes |
| `just compose-logs` | `docker compose logs --follow` | Follow service logs |
| `just compose-check` | `docker compose config --quiet` | Validate Compose without starting or printing configuration |

Build explicitly before starting:

```sh
just build
just start
```

The npm equivalents are `npm run build` followed by `npm start`. Startup requires
explicit database configuration, waits for PostgreSQL, migrates, then listens.
`dev`, `test-watch`, service startup and log-follow commands are long-running;
test and check commands are finite.

Vitest discovers only first-party tests, split into `tests/unit/` and
`tests/integration/`. Vendored `repos/` sources are excluded. Coverage is scoped
to `src/` (no coverage provider is installed by this increment). An empty selected
suite fails deliberately. `check` includes database-free tests; run integration
tests separately. HTTP unit tests substitute the health dependency and do not
establish PostgreSQL correctness.

Recipes inherit the caller's environment and do not load `.env` files or enter
Nix automatically. npm entry points use the same environment behavior. There are
no seed commands yet. Database/Compose commands are explicit and are not part of
ordinary `check`.

## Native configuration and private secrets

Native development uses the NixOS-managed database `sitetrack` and login role
`sitetrack`. Integration tests use `sitetrack_test` and its matching login role.
The repository does not provision host services, roles, or authentication rules.

Create separate SOPS-encrypted dotenv bundles in the repo-local `secrets/`
directory, using your existing recipient/key setup:
`secrets/dev.enc.env` and `secrets/test.enc.env`. Both Git and the Docker build
context exclude this directory. Keep private keys separately managed.
The development bundle contains `DATABASE_URL`; the test bundle contains only
`TEST_DATABASE_URL` and `SITETRACK_TEST_DISPOSABLE=true`. See `.env.example` for
placeholders. Percent-encode reserved characters in URL passwords. Do not copy
real values or private keys into Git, Docker build arguments, or chat.

```sh
sops exec-env secrets/dev.enc.env 'just dev'
sops exec-env secrets/dev.enc.env 'just db-check'
sops exec-env secrets/test.enc.env 'just db-test-check'
sops exec-env secrets/test.enc.env 'just test-integration'
```

SOPS decrypts into the launched process environment; no application code depends
on SOPS and no plaintext file is needed. Any explicit environment provider can
be used instead. The implementation and database-free checks do not need these
private bundle files.

| Setting | Behavior |
| --- | --- |
| `DATABASE_URL` | Required PostgreSQL TCP URL with explicit host, role and database |
| `DATABASE_SCHEMA` | Defaults to `sitetrack`; lowercase letters/digits/underscore, maximum 63 characters, starts with a letter |
| `HOST` | Defaults to `0.0.0.0` |
| `PORT` | Defaults to `3000`; integer 0–65535 (0 requests an ephemeral test port) |
| `TEST_DATABASE_URL` | Required separately for integration; no development fallback |
| `SITETRACK_TEST_DISPOSABLE` | Must be exactly `true` for test commands |

Database URLs reject query parameters and fragments to prevent connection-option
overrides; the current native/reviewer paths use local TCP connections. Pool size
is five, acquisition is bounded to two seconds, connection setup to three seconds,
and statements/locks to five seconds. Startup has a 30-second deadline and retries
only retryable probe failures. Migration failures are not automatically retried.

Only the migration command and application startup apply migrations. Database
inspection commands never create schema objects. Both test commands require an
explicit local `sitetrack_test` target and disposal acknowledgement; before test
DDL/cleanup, the connected database and role are checked again. Each test creates
a unique schema and removes only that schema after verifying its original OID.
No development database, public tables, or existing test schemas are reset.

For direct read-only inspection, let `psql` prompt for the password:

```sh
psql -X -h 127.0.0.1 -U sitetrack_test -d sitetrack_test \
  -c "SELECT current_database(), current_user, current_setting('server_version');"
```

## HTTP and lifecycle

```sh
curl -i http://localhost:3000/health/live
curl -i http://localhost:3000/health/ready
curl http://localhost:3000/openapi.json
```

Liveness returns `200 {"status":"ok"}` without SQL. Readiness returns
`200 {"status":"ready"}`, or within approximately two seconds a 503 response:

```json
{"code":"DATABASE_UNAVAILABLE","message":"Database is unavailable.","requestId":"<generated UUID>"}
```

Every application response includes a generated `X-Request-Id`; incoming IDs are
not trusted. Unknown routes return a 404 error body; unexpected handler defects
return a generic 500. Logs are JSON and include method, status, duration and
request ID, omitting URLs/query strings, headers, bodies, credentials and raw SQL
errors. OpenAPI documents the health contracts and declared error bodies; no
business endpoints exist yet.

SIGINT/SIGTERM closes the listener, allows requests up to ten seconds to drain,
and releases pooled connections. Graceful signal shutdown exits zero; startup
configuration/database/migration failure exits nonzero. The initial migration
creates the project-number sequence; it does not create users or demo business
data. Later stages add business schema and the explicit small/large seed loaders.
