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

## Docker rehearsal: 14 November 2026

The Nix shell supplies Docker CLI 29.9.2, Compose 5.7.0 and Buildx 0.38.1.
The client reached the local Docker Engine 29.7.2 through
`unix:///var/run/docker.sock`; `just compose-check` passed.

Startup of a fresh project, `sitetrack-stage1-20261114-209a26`, was attempted using:

```sh
docker --host unix:///var/run/docker.sock compose --env-file /dev/null \
  -f compose.yaml -p sitetrack-stage1-20261114-209a26 \
  up --detach --wait --wait-timeout 120
```

Compose override variables were removed from the launched process environment.
No SOPS bundles were read, no environment file was required, and no native
database was accessed. The project had no pre-existing image, containers or
volumes. Compose automatically attempted to build the API without a separate
build or migration command.

| Check | Result |
| --- | --- |
| `nix develop --command just check` | Passed type-checking, 21 unit/HTTP/startup tests and production build after the rehearsal; PostgreSQL integration suite was not rerun because application/database source did not change |
| PostgreSQL image pull | `postgres:16.16-bookworm` pulled successfully |
| Node image resolution | `node:24.22.3-bookworm-slim` resolved to manifest digest `sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54` |
| Build context | 91.97 kB transferred; `.dockerignore` loaded |
| Dependency installation | Failed in `npm ci --omit=dev`: `getaddrinfo EAI_AGAIN registry.npmjs.org`; parallel build-stage install canceled |
| Container DNS diagnostic | Temporary PostgreSQL-image container could not resolve `registry.npmjs.org` within 10 seconds; host lookup succeeded |
| Container outbound diagnostic | Direct TCP connection to `1.1.1.1:443` returned `No route to host`, without requiring DNS |
| Bridge configuration | `172.17.0.0/16`, gateway `172.17.0.1`, masquerading enabled, Docker firewall backend iptables, host IPv4 forwarding enabled |
| Runtime qualification | Not run: image did not build; HTTP, outage/recovery, runtime contents/user and persistent restart remain unverified in Docker |
| Cleanup | `compose down` completed without volume deletion; no project containers, network or volume existed afterward; temporary diagnostic containers removed automatically |

Follow-up diagnosis found that the host's generated `20-ethernet.network`
matched all `Type=ether` interfaces. While a diagnostic container was running,
its host-side veth had no bridge master, `docker0` had no member ports, and the
container could not resolve its gateway's MAC address. Fabrizio narrowed the
Ethernet match to `Name=en* eth*` in his NixOS configuration. A fresh probe then
confirmed the veth remained attached to `docker0`, gateway ARP resolved, and
container DNS and direct outbound TCP succeeded. The separate Wi-Fi rule remained
in place. NixOS's nftables firewall and Docker's iptables-nft rules did not require
changes. Host configuration and privileged commands were handled by Fabrizio;
the agent used no sudo commands for the repair or retest.

### Successful rehearsal after host repair

The first post-repair project, `sitetrack-stage1-20261114-61fe46`, built the API
successfully, but fresh PostgreSQL initialization exceeded the original health
check's failure budget. The database became healthy after Compose had already
refused to start the API. The repository fix adds a 90-second database health
startup period and checks TCP on `127.0.0.1`, avoiding premature readiness from
the temporary Unix-socket-only initialization server. No database durability
settings, dependency pins, application source or migrations changed.

The complete rehearsal then passed with a new project,
`sitetrack-stage1-20261114-a97030`, and a fresh database volume. Startup used the
same command shown above with the new project name, without `--build`, a prior
migration command or environment-file copy. Existing image layers were cached;
the preceding post-repair build had successfully run both npm installation
stages and the production TypeScript build.

| Check | Result |
| --- | --- |
| Fresh Compose startup | API and PostgreSQL healthy within the 120-second wait; no private configuration required |
| Runtime versions | Node.js 24.22.3 and PostgreSQL 16.16; database/role both `sitetrack` |
| Operational HTTP | Live/ready, OpenAPI health operations, bundled Swagger/assets, fresh request IDs and sanitized 404 passed |
| Migrations | Exactly one ledger row, `1 / project_number`, unchanged after restart |
| Database outage | Liveness 200; readiness returned sanitized 503 in 2,005 ms; readiness recovered after restarting only the database, with the same API container |
| Graceful shutdown | API exited 0 in 1,673 ms |
| Persistent restart | `down` preserved the named volume; subsequent `up` became healthy; sequence continued from 1 to 2 |
| Runtime packaging | User `node`, UID 1000; `/app` contains only `dist`, production `node_modules` and `package.json`; no project TypeScript/tsx/Vitest development dependencies |
| Database isolation | No published PostgreSQL host port |
| Request logging | A fresh probe's request ID appeared in API logs; query sentinel and database credentials did not |
| Compose validation | `nix develop --command just compose-check` passed after the health-check change |
| Final repository check | `nix develop --command just check` passed type-checking, all 21 unit/HTTP/startup tests and the production build |
| Final cleanup | Both post-repair projects stopped; containers and networks removed; database volumes retained |

Verified API image manifest-list digest:
`sha256:a6012401195a58e9f8402da7c69c02eaa131115f17871f15f2b53efae768ddd9`.
The first recovery probe encountered a closed reused HTTP socket; the API was
still running with restart count zero and a fresh readiness request passed.
The complete outage/recovery check was repeated successfully with fresh HTTP
connections. No application change was needed for that probe issue.

Retained volumes are `sitetrack-stage1-20261114-61fe46_postgres_data` (the
initialization-health-check failure) and
`sitetrack-stage1-20261114-a97030_postgres_data` (the successful rehearsal).
Neither volume was deleted or reset. No native databases or private SOPS bundles
were accessed. These checks establish Docker foundation startup/restart evidence;
business acceptance cases, scale and the final clean-machine submission rehearsal
remain later-stage work. The existing nine-test PostgreSQL integration result
above is separate evidence and was not rerun for this Compose-only change.

### Repeating the startup/restart smoke

Use a new, previously unused project name and bypass local environment files:

```sh
review_project="sitetrack-stage1-review-$(date +%Y%m%d%H%M%S)"
review_compose() {
  docker --host unix:///var/run/docker.sock compose --env-file /dev/null \
    -f compose.yaml -p "$review_project" "$@"
}
review_compose up --detach --wait --wait-timeout 120
curl --fail http://localhost:3000/health/ready
curl --fail http://localhost:3000/openapi.json
review_compose exec -T db psql -X -v ON_ERROR_STOP=1 -U sitetrack -d sitetrack \
  -c "SELECT nextval('sitetrack.project_number_seq');"
review_compose down
review_compose up --detach --wait --wait-timeout 120
review_compose exec -T db psql -X -v ON_ERROR_STOP=1 -U sitetrack -d sitetrack \
  -c "SELECT nextval('sitetrack.project_number_seq');"
review_compose down
```

Run with Compose override variables unset, and confirm the chosen project has
no existing containers or volumes before starting it. The commands above cover
startup/restart only. Also verify all operational routes and local Swagger assets,
fresh request IDs and sanitized errors, migration-ledger uniqueness, readiness
503 within three seconds while PostgreSQL is stopped with liveness still 200,
recovery without an API restart, and API SIGTERM exit 0 within 15 seconds.
Inspect the running API user and runtime contents, database port isolation, and
logs for request/credential leakage before recording a Docker qualification pass.
Check that the second sequence value continues rather than resetting. These
commands use only the isolated reviewer environment and preserve its volume.
Port 3000 must be available. Do not substitute native results for BOOT-01.
