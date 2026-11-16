# Stage 5: datasets, measurement and submission

Stage 5 adds explicit local seed and benchmark tools. Ordinary `docker compose up`
still starts only the API and PostgreSQL. It does not seed or benchmark anything.
No Nix, Just, SOPS or private environment bundle is needed by reviewers.

The API is backend-only. Use `/docs`, curl or any HTTP client; no browser UI
is part of the assignment deliverable.

## Running the tools

From the repository root, using the Nix shell if desired:

```sh
nix develop
just bench-up small
just seed-small
just seed-check small
just bench-smoke small
just bench-report small
just bench-down small

# Explicit full assignment dataset; independent project, volume and port.
just seed-large
just seed-check large
just bench-smoke large
just bench-focus large
just bench-plans large
just bench-integrity-plan large estimate
# Explicitly execute the inventory audit query under EXPLAIN ANALYZE:
just bench-integrity-plan large analyze
just bench large
just bench-report large
just bench-status large
just bench-down large
```

`bench-up` builds both the API and tooling image. Seed recipes also build them,
start PostgreSQL, stop that profile's API during loading and start it once the
seed verifies. Running the same completed seed again verifies and reuses it.
`bench-down` retains all volumes. There is no reset or volume-deletion recipe.
Failed/interrupted seeds are retained and refused on a subsequent seed command.
Choose a new run name for a fresh environment rather than overwriting them:

```sh
SITETRACK_SCALE_RUN=second just seed-small
SITETRACK_SCALE_RUN=second just bench-smoke small
```

Both profiles default to run name `local`. Projects are
`sitetrack-scale-small-local` and `sitetrack-scale-large-local`; published API
ports are 3001 and 3002 respectively. A new run name still uses that profile's
port, so stop the earlier environment first. Names are validated. Private native
DATABASE_URL values are not used by these Compose tools. Docker must target a
local Unix socket; the resolved endpoint is explicitly pinned for every operation.
SIGINT/SIGTERM stops the wrapper's named one-off tools container; SIGKILL can
leave a retained loading manifest or stale host lock for inspection. Compose explicitly disables automatic `.env` loading.

Just is a thin wrapper. Canonical npm equivalents include `npm run seed:small`,
`npm run seed:large`, `npm run seed:check -- large`, `npm run bench:smoke -- small`,
`npm run bench:focus -- large`, `npm run bench -- large`, `npm run bench:plans -- large`, `npm run bench:status -- large`
and `npm run bench:report -- large`. Use `just --list` for all wrappers.

Without Node/Nix/Just installed on the host, use Docker directly. This example
sets up the small profile; use a distinct project and port for large:

```sh
export SITETRACK_HTTP_PORT=3001
docker compose --env-file /dev/null -p sitetrack-scale-small-local -f compose.yaml -f compose.benchmark.yaml build api tools
docker compose --env-file /dev/null -p sitetrack-scale-small-local -f compose.yaml -f compose.benchmark.yaml up -d --wait db
docker compose --env-file /dev/null -p sitetrack-scale-small-local -f compose.yaml -f compose.benchmark.yaml run --rm --no-deps -T tools seed small
docker compose --env-file /dev/null -p sitetrack-scale-small-local -f compose.yaml -f compose.benchmark.yaml up -d --wait api
docker compose --env-file /dev/null -p sitetrack-scale-small-local -f compose.yaml -f compose.benchmark.yaml run --rm --no-deps -T tools check small
docker compose --env-file /dev/null -p sitetrack-scale-small-local -f compose.yaml -f compose.benchmark.yaml run --rm --no-deps -T tools smoke small
docker compose --env-file /dev/null -p sitetrack-scale-small-local -f compose.yaml -f compose.benchmark.yaml down
```

Tools emit JSON to stdout and progress to stderr. Completed benchmark cases are
also written as safe progress events and retained in host progress logs, so a
later error or interruption does not discard already completed case evidence. Direct Docker users can redirect
stdout to a report file; npm/Just orchestration additionally saves reports and host
metadata under ignored `.scale-results/<project>/`. `bench-report` displays the
last saved report. Reports contain no access tokens, cookies, password hashes or
connection strings. Keep measurements sequential: independent volumes still
share this laptop's CPU, RAM and HDD. Existing native integration tests continue
to require explicit disposable test configuration (`just test-integration`).

## Demo accounts

All generated users have the public local-only password `SiteTrack local demo password 42!`.

| Email | Role and useful behavior |
| --- | --- |
| `user1@sitetrack.example` | SuperAdmin; company-wide reads and store access, without automatic project-admin membership |
| `user2@sitetrack.example` | CompanyStoreManager; company stock/deliveries, no project membership |
| `user3@sitetrack.example` | User; seeded project administrator, including PRJ-0001 |
| `user4@sitetrack.example` | User; ordinary member of PRJ-0001 |
| `user100@sitetrack.example` / `user5000@sitetrack.example` | Small/large outsider to PRJ-0001 for access checks |

The first project is PRJ-0001. Its first task is PRJ-0001-T-0001; the last is
PRJ-0001-T-0300 in small and PRJ-0001-T-3000 in large. Login examples in Stage 2
apply unchanged. Credentials are deliberately public demo data, separate from
native SOPS configuration.

## Dataset design and verification

| Entity | Small | Large |
| --- | ---: | ---: |
| Users | 100 | 5,000 |
| Projects | 20 | 2,000 |
| Invitations/notifications | 500 | 50,000 |
| Tasks | 2,000 | 500,000 |
| Dependency edges | 4,000 | 1,000,000 |
| Materials | 200 | 20,000 |
| Deliveries | 1,000 | 400,000 |
| Delivery lines | 7,500 | 3,000,000 |

Generator version 2 uses seed 42 and reference date 2026-11-01. Business records,
IDs and distributions are repeatable; the demo password hash uses a fresh salt.
Dates do not advance automatically, while API Late flags use the real company
calendar date. The manifest and reports identify the reference date.

The large profile includes four 3,000-task projects. Other projects have varied
sizes around the remaining average. The first graph is a long chain; the second
has broad fan-out, and the remaining graphs include overlapping paths/diamonds.
Dependencies point to lower task numbers, providing a checkable topological
certificate. Completed tasks form a prefix; only the next task is InProgress,
so every started task's prerequisites are Done. Memberships vary from 5 to 50,
with at least one admin, and users have all three assignment roles.

Every project first receives a delivered opening shipment. Subsequent deliveries
include both directions and all four statuses. Exact fractional quantities,
immutable line snapshots, dispatch/receipt/refund movements and historical stock
prefixes are generated consistently. Some unused company materials have zero,
low and available stock. Movement rows add to the assignment's required row count
and are included in measured storage.

`seed-check` verifies exact counts, membership/admin limits, project/task counters,
edge topology and task transitions, invitation/notification consistency, line
limits, movement phases/quantities/destinations, historical nonnegative stock and
current balance/activity reconciliation. Database constraints remain enabled.
All mutations are explicit and parameterized. Loader inserts are bounded bulk
SQL rather than millions of HTTP requests.

Migration 0007 adds only seed metadata. Loading requires an explicit opt-in and an
empty application dataset, apart from the migration-created company store.
Existing data, incomplete manifests and incompatible generator settings are
refused. The loader never truncates tables, resets retained counters or removes
volumes. Committed batches survive interruption; the manifest prevents treating
those partial rows as a valid dataset. A session advisory lock serializes seed,
verification and benchmark operations across connections. Host wrappers also
use an operation lock file; inspect its PID before removing a stale lock after
SIGKILL. Status and report inspection remain available while an operation runs.

## Measurement protocol

The API has 1 CPU/1 GiB and PostgreSQL 1 CPU/3 GiB. The separate tools container
has 1 CPU/512 MiB; it is the load generator, outside the system-under-test budget
but on the same host. PostgreSQL fsync, synchronous_commit and full_page_writes
must all be on. Application timeouts and the five-connection pool remain intact.
Offline seed/check/plan statements have a separate 300-second limit and a
five-second lock limit.

Smoke runs use two concurrent clients and 20 measured requests per case. Full
runs perform three repetitions, with ten concurrent clients, 20 warmup requests
and 200 measured requests per case/repetition, followed by a 60-second mixed
screen workload each repetition. Requests have a ten-second deadline; individual
case work is bounded to 120 seconds. This is a closed-loop workload, not an
unlimited arrival-rate capacity claim. Client-side schema validation is included
in request timing. Login happens outside timed samples.

Cases cover profile, member/company project lists, derived sorting/filtering,
project details, tasks/flags/sorts/deep pages, task details and both relationship
directions, project stock/deliveries/members/invitations, materials, company stock
and company deliveries, notifications and unread count. Access probes check
hidden projects and company-store restrictions before and after measurement.
Login setup is recorded outside timed read samples; authentication/registration
correctness and admission limits are covered separately by integration tests.
Focused runs use ten clients, one repetition, 20 warmup and 50 measured requests
for 13 cases: project lists/detail, company delivery lists, and profile/tasks/
prerequisites/materials as controls. They omit the mixed workload. Use them for
shorter before/after diagnostics; a focused pass does not qualify the full run.
Reports identify `mode` as `smoke`, `focus` or `bench`. Percentiles describe
successful measured responses; error counts and total attempts also include
first access and warmup. `complete` means all measured attempts finished, while
`passed` additionally requires no request errors and all expected cases.
New reports include `phaseResults` for first access, warmup and measured requests,
with attempts, successes, errors and error rates for each phase. Per-case
`failures` record only the case, repetition, phase, timestamp, fixed error label
and validated response request ID; bodies, headers and credentials are omitted.
Mixed traffic retains up to 100 failure records per repetition and reports how
many were omitted. Existing aggregate `errors`, `attempts` and `errorRate` retain
their all-phase meaning. Failed warmup still fails the verdict even when every
measured request succeeds. Latency-target misses alone do not fail the command.
`verdict` distinguishes `passed`, `request_errors`, `incomplete` and
`execution_failed`. A failed benchmark emits `BenchmarkFailed`, while invalid
configuration retains `ConfigurationError`.

Every smoke/focus/full/plan attempt also captures dated `*-api.jsonl`,
`*-postgres.jsonl` and `*-diagnostics.json` files before returning, including
when the tool exits unsuccessfully without a report. Capture uses that attempt's
time window and the last 50,000 log lines per service. API output is decoded and
projected to request timings/status/IDs and fixed database-failure categories;
PostgreSQL output retains only recognized timeout/deadlock/connection-capacity/
out-of-memory event labels and timestamps. Raw PostgreSQL logs can contain SQL
and parameters and are never saved. Unknown formats are discarded. Each source
is marked saved, partial or unavailable; an empty file does not establish absence
of failures. Sources record a fixed failure reason and exit code, distinguishing
timeouts, failed/missing commands or containers, output limits, interruption and
file-write failures. Capture reads identified container IDs directly, one service
at a time, with a 30-second deadline and 16-MiB byte limit per service. On timeout
or command failure, complete recognized events received so far are still saved
as partial evidence. Raw diagnostic-command stderr is never printed or saved. Diagnostic
capture failures do not overwrite the benchmark verdict.
Completed reports also record host CPU/I/O/memory pressure counters before and
after the run; these are cumulative stall microseconds, not per-request timings
or proof of a particular cause. Capture happens before `bench-down`, so these
files survive container removal. No extra command is required.
The latest report may be a focus run or query-plan capture; retain dated files
when comparing against a full benchmark.
First accesses are reported separately; no host caches are cleared, so these are
not OS-cold measurements. Later repetitions are already warm.

Reports include p50/p95/p99, throughput, sample counts, errors and timeouts, plus
revision/dirty state, dataset profile, storage, PostgreSQL version/durability,
host CPU/RAM/OS, resource budget and container identity. Full qualification uses
the large profile. Small-profile measurements establish tool behavior only.
Unexpected HTTP/schema failures or incomplete runs fail the command. Targets
are reported separately: warm common-page p95 <=500 ms and worst-project
detail/graph p95 <=1 second. These are engineering targets, not additional
assignment pass/fail requirements.

`bench-plans` captures actual repository statements through Effect's SQL
`Statement.CurrentTransformer`, then runs parameterized read-only
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`. It never explains mutations or emits
authentication statements. Installed Effect 4.1.2 exports/types are authoritative;
see `repos/effect/packages/effect/src/sql/Statement.ts` and
`repos/effect/packages/sql/pg/src/PgClient.ts` for the transformer and dedicated
single-connection client used by the tooling.

`just bench-integrity-plan large estimate` (`npm run bench:integrity-plan -- large estimate`)
explains the movement phases/quantities/destinations audit directly. It verifies
the matching completed seed manifest and its saved counts and takes the existing
dataset lock, but deliberately does not run the full audit first. Default mode
is `estimate`; explicit `analyze` executes the same fixed SELECT in a read-only
transaction with the existing five-minute tools statement limit. The report
retains the estimate and a safe SQL failure tag even if analysis times out;
`IntegrityPlanFailed` produces a nonzero exit. These files use
`integrity-plan-estimate-*` or `integrity-plan-analyze-*` names. Success means
EXPLAIN completed, not that all dataset invariants passed. Ordinary
seed-check/smoke/focus/full/plans commands retain the complete preflight.

The movement audit now partitions all actual delivery UUIDs into nonoverlapping
ranges of up to 2,000 deliveries and materializes only the corresponding lines
and movement phases before joining them. One SQL statement preserves a single
snapshot and counts every violation across all ranges. It uses existing indexes;
no timeouts, durability settings or memory budgets are relaxed.

## Clean focused checkpoint — 16 November 2026

The owner-run `focus-2026-11-16T09-30-50.169Z.json` completed all thirteen cases
with `verdict: passed`: 650/650 successful measured responses, 260/260 warmup
responses and 13/13 first accesses. No HTTP/schema errors were recorded. All
978 saved API diagnostic events were request events, with no 5xx responses;
403/404 responses matched the expected access probes. Both diagnostic sources
were saved without capture errors; PostgreSQL had no recognized failure events.

Measured p95 timings on the retained large dataset:

| Case | p95 (ms) | Target (ms) |
| --- | ---: | ---: |
| Profile | 171 | 500 |
| Member projects | 1,101 | 500 |
| Company projects | 1,084 | 500 |
| Completion sort | 4,509 | 500 |
| Lateness sort/filter | 4,994 | 500 |
| Deep project search | 404 | 500 |
| Project detail | 209 | 1,000 |
| Tasks | 651 | 500 |
| Prerequisites | 503 | 1,000 |
| Materials | 141 | 500 |
| Company deliveries | 687 | 500 |
| Filtered deliveries | 1,399 | 500 |
| Deep deliveries | 1,101 | 500 |

Five of thirteen engineering targets were met. The API/database still shared
2 CPUs/4 GiB, with normal durability and unchanged application deadlines/pool.
The whole focused command took 197 seconds including preflight. Host I/O full
stall time was 48 seconds, about 24% of that window, compared with 192 seconds
of a 456-second previous run (42%). Audit implementation, caches and background
host activity changed; this comparison cannot assign gains to any one factor.

`plans-2026-11-16T09-34-46.303Z.json` also completed full preflight and all thirteen
API plans. None showed temporary blocks or JIT compilation. Individual SQL
timings included projects 71ms, completion 261ms, lateness 254ms, company
deliveries 27ms and deep deliveries 141ms. These are isolated query timings,
not end-to-end HTTP p95 values. Dated raw reports remain local and ignored.

This is a clean focused checkpoint, not completed Stage 5 qualification. The
longer three-repetition mixed workload, native comparison, review reconciliation
and fresh-checkout rehearsal remain outstanding. Earlier failed runs and
full-suite fixture startup timeouts are retained in the historical evidence
below rather than erased by this focused pass.

The final checkpoint check passed formatting, warning-free lint, types, all 88
unit tests and build. Its full real PostgreSQL suite returned 53/56 in 320s:
the lifecycle restart and seeded-account/API tests failed during database
startup, and the movement-corruption/range-boundary test hit a statement timeout.
Server diagnostics recorded DDL timeouts/cancellation, including task-dependency
table and delivery-index creation. Setup timing reliability remains unresolved;
the full integration suite is not green. The affected focused scale suite had
previously passed all six cases. No limits or durability settings were relaxed,
and the failed run cleaned all test-owned schemas and stopped its disposable
PG16.16 cluster. These failures are recorded alongside the clean focused HTTP
run; they are not hidden by it.

## Execution evidence

Qualification is in progress. On 15 November 2026, the large generator-v2 dataset
loaded with every required count above and passed its SQL invariant checks.
Loading took 17m53s and database size was 3,552,091,159 bytes (3.55 GB decimal),
including stock movements. PostgreSQL 16.16 had fsync, synchronous_commit and
full_page_writes enabled. The host was an HDD laptop with about 8 GiB RAM; the
container limits above were verified. These timings are machine-specific.

The initial large smoke test exposed project-list 503 responses: summaries
aggregated the company-wide task graph before pagination. The revised query
summarizes only the page where sorting/filtering permits, preserves full visible
status/date aggregation for derived sorts and filters, and computes blocked
counts only for selected projects. Graph joins use indexed task tables directly:
an intermediate materialized task result caused millions of repeated lookups in
a 3,000-task chain. An isolated plan improved from 11,743 ms to 14 ms after removing
that intermediate result. Blocking still propagates through Done intermediates;
unfinished prerequisites remain relevant transitively.

After rebuilding against the retained dataset, all 28 smoke cases completed with
20 measured requests each, zero HTTP/schema errors, and access probes passing.
This was one repetition, two clients and two warmup requests per case. Selected
HTTP p95 measurements (milliseconds):

| Case | Initial smoke | Revised smoke |
| --- | ---: | ---: |
| Member project list | 503; no successful samples | 697 |
| Company project list | 503 | 798 |
| Completion sorting | 503 | 1,326 |
| Late filtering/sorting | 503 | 1,277 |
| Project search/deep page | 503 | 453 |
| Worst-project detail | 2,573 | 174 |

The actual default project-list SQL plan improved from 3,772 ms to 331 ms;
temporary blocks fell from 22,776 read / 24,569 written to 2,239 in each direction.
The revised detail plan took 56 ms without temporary blocks. SQL plan execution
and HTTP latency measure different work. No cache clearing, durability changes,
larger resource limits or relaxed application timeouts were used.

Only 19 of 28 smoke cases met their latency targets. Remaining misses included
the first four project lists above, company stock, ordinary/deep company delivery
lists, notifications and unread count. Delivery-list plans still spill to disk.
These short measurements establish that the reproduced project timeouts are
resolved under this workload; they do not establish ten-client performance or
prove that every latency difference is caused by the query change.

Local ignored evidence is under
`.scale-results/sitetrack-scale-large-verified/`: `seed.json`,
`smoke-2026-11-15T09-27-03.569Z.json` (initial),
`plans-2026-11-15T09-36-23.244Z.json` (initial),
`smoke-2026-11-15T20-07-19.074Z.json` (revised) and
`plans-2026-11-15T20-13-19.365Z.json` (revised). The revised API image was
`sha256:25d68e936b7239835f2e10f68de0ccaa9824c9ef683877129c69193aa569f6b5`.
These artifacts are local evidence, not committed deliverables.

Fresh `npm run check` passed formatting, lint, types, 71 unit tests and the
production build. All 17 focused PostgreSQL tests in projects/tasks/scale passed,
including 3,000-task traversal, Done-intermediate blocking, scoped pagination,
seed-manifest corruption and post-seed login/identifier allocation.

The first full three-repetition ten-client benchmark subsequently completed:
16,800 measured attempts included 1,076 HTTP503 errors, and mixed traffic had
42 errors out of 1,238 requests. Its dated report is
`bench-2026-11-15T20-20-54.154Z.json`. It failed qualification.

A later SQL optimization pass added focused measurement, correlated project
graph calculations, status-carrying recursion, set-membership filtering and
separate delivery count/page-ID queries. Its matched focused baseline had
91 errors out of 650 measured attempts; `focus-2026-11-15T22-23-13.883Z.json`
reduced that to five (one completion-sort and four late-summary failures).
That run still fails the zero-error gate. Plans dated
`plans-2026-11-15T22-27-36.127Z.json` measured default projects 72ms, completion
313ms, late 346ms, company deliveries 29ms and deep deliveries 74ms, without
temporary-block spills or JIT compilation in those queries.

The latest source adds an unfiltered SuperAdmin aggregate fast path, retaining
visibility at the project join and verifying deleted-project isolation. It
passed targeted PostgreSQL tests; its HTTP measurement was paused during
integrity preflight at the owner's request, so its performance is unverified.
Current formatting/lint/types/build and 74 unit tests passed. Two full PostgreSQL
runs each passed 53/54 cases, with different tests failing during fixture DDL
startup because of statement timeouts. The affected workflows passed separately;
the complete suite is not consistently green. These limitations remain open.

Final full qualification, review reconciliation and fresh-checkout rehearsal
remain outstanding. Stage 5 and submission readiness are not yet qualified.
The retained benchmark stack was stopped for the pause; its volume is preserved.
On this working machine,
set `SITETRACK_SCALE_RUN=verified` before using its existing dataset; default
`local` trial volumes predate the verified seed.

The owner's next focused run, `focus-2026-11-16T06-50-31.164Z.json`, completed all
13 cases with 650 successful measured requests and no measured/schema errors.
One filtered-delivery warmup request returned HTTP503, so the overall verdict
still failed. The old CLI mislabeled that verdict `ConfigurationError`; the
reporting changes above correct this without weakening failure criteria. Only
two of thirteen latency targets were met; completion/late p95 were 5370/4990ms.
The higher recorded host load and slower unchanged controls suggest contention,
but that run did not retain enough server diagnostics to classify its one 503.
Plans `plans-2026-11-16T06-58-05.748Z.json` measured completion 232ms, late 279ms,
default projects 73ms, ordinary deliveries 27ms and deep deliveries 78ms, all
without temporary blocks or JIT. These are isolated SQL timings, not HTTP p95.
The owner stopped the stack afterward; the retained dataset remains intact.

The next owner-run focus, `focus-2026-11-16T07-37-52.622Z.json`, finished with
649/650 successful measured requests, one measured late-list HTTP503 and one
filtered-delivery warmup HTTP503. All schemas passed; zero latency targets met.
Both old log captures were unavailable. Host I/O pressure increased by 206 seconds
some and 192 seconds full across its 456-second window including preflight;
these counters do not identify the responsible process. The subsequent plan
attempt failed during the movement audit preflight with a saved PostgreSQL
statement-timeout event, before any API EXPLAIN was captured.

Direct diagnosis on the retained large dataset produced
`integrity-plan-analyze-2026-11-16T08-49-21.522Z.json`: the original audit took
38,241ms and read/wrote 173,884/175,024 temporary 8-KiB blocks, about 1.4GB each.
Its large hashes used 64 batches. A range-only prototype removed temp traffic
but still took 37,397ms due to millions of point probes. Materializing local
inputs reduced the prototype to 10,570ms. The production parameterized query
in `integrity-plan-analyze-2026-11-16T09-13-25.014Z.json` took 29,744ms with zero
temporary blocks and successfully saved both live API and PostgreSQL captures.
These individual diagnostic timings vary with cache/host activity and do not
establish an HTTP latency improvement. Normal durability and resource budgets
were preserved. No dataset rows were changed. The explicit `seed-check` entry
point also reuses its first verification result, avoiding a duplicate full audit.

`plans-2026-11-16T09-15-48.652Z.json` subsequently completed the entire large seed
preflight and all 13 API execution plans in 85.6 seconds, with both diagnostic
sources saved. All minimum counts and inventory checks passed with normal
durability. No HTTP benchmark was run as part of this diagnosis; its remaining
503s/latency misses require a new focused measurement on a quieter host.
