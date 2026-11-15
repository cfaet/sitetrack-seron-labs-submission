# Stage 3: tasks and dependency graphs

Stage 3 adds task CRUD, status actions, dependency management, transitive graph
details and project task summaries. Authentication follows [Stage 2](STAGE2.md).
No dependency version changes, compiler patches, host service changes or new
private secrets are needed for this increment. Inventory and full-dataset scale qualification remain
later stages.

## Dates, identifiers and access

`COMPANY_TIME_ZONE` is an optional API setting, defaulting to `Asia/Muscat`.
It must be a named timezone, such as `America/Bogota` or `UTC`; invalid/empty
values and numeric offsets fail before database startup. Database CLI commands
do not read this setting. Effect `DateTime` converts a single captured instant
into the company calendar date; pure domain functions receive that date explicitly.
Neither the laptop timezone nor the PostgreSQL session timezone determines Late.

Task names are trimmed and accept 1–200 UTF-16 code units. Dates use validated
Gregorian `YYYY-MM-DD` strings, start on/before end; they may lie outside project
dates. Event timestamps are UTC ISO strings. IDs such as `PRJ-0001-T-0001` use a
per-project counter, retain at least four numeric digits and grow past 9999.
Deletion/restarts do not reset counters or reuse issued IDs. Aborted transactions
do not issue identifiers to clients.

Current project members and SuperAdmins can manage tasks and dependencies without
project-admin membership. CompanyStoreManager has ordinary member access to
tasks. Every path checks task/prerequisite ownership within its project. Outsiders
receive the same 404 for existing and absent project resources; knowing an ID
does not grant access. Membership and roles are checked again after write locking.

## HTTP contracts

All paths below are relative to `/api/v1/projects/{projectId}`. Send a Bearer
access token. JSON writes require `Content-Type: application/json`. The auth-only
CSRF header is not required by task routes.

| Method/path | Input | Result |
| --- | --- | --- |
| GET `/tasks` | Task list query | Paginated task rows |
| POST `/tasks` | `{ name, startDate, endDate }` | 201 task detail, initially NotStarted |
| GET `/tasks/{taskId}` | — | Task detail and `allowedActions` |
| PATCH `/tasks/{taskId}` | At least one of name/startDate/endDate | Updated task detail |
| DELETE `/tasks/{taskId}` | — | 204; soft deletion with incoming-edge guard |
| POST `/tasks/{taskId}/start` | `{}` | Updated task detail |
| POST `/tasks/{taskId}/complete` | `{}` | Updated task detail |
| POST `/tasks/{taskId}/reopen` | `{}` | Updated task detail |
| POST `/tasks/{taskId}/dependencies` | `{ prerequisiteTaskId }` | 201 `{ dependentTaskId, prerequisiteTaskId }` |
| DELETE `/tasks/{taskId}/dependencies/{prerequisiteId}` | — | 204 |
| GET `/tasks/{taskId}/prerequisites` | page/pageSize | All reachable prerequisites, paginated |
| GET `/tasks/{taskId}/dependents` | page/pageSize | All reachable dependents, paginated |

Task rows contain `id`, `projectId`, `name`, `startDate`, `endDate`, `status`,
`firstStartedAt`, `late`, `blocked`, `directPrerequisites` (id/name/status) and
`directDependentCount`. Detail/command responses add `allowedActions`, containing
only currently valid `start`, `complete` or `reopen` actions. These are advisory:
commands validate again under the project lock. Relationship items add `distance`.
Relationship pages sort by shortest distance then numeric task number. Follow
`pagination.totalPages`; the default 25 rows is a page, not a graph-size cutoff.

Task lists accept page/pageSize, case-insensitive name/ID search, one `status`,
`late`/`blocked` literal `true` or `false`, and inclusive planned-range overlap
using `fromDate`/`toDate`. Either endpoint can be omitted; inverted ranges fail.
Sort by `id` (default), `name`, `startDate`, `endDate` or `dependentCount`, with
`direction=asc` (default) or `desc`. Numeric ID sorting puts 10 after 9. Other
sort ties use immutable internal IDs. Page size defaults to 25 and caps at 100;
unknown query/body fields fail.

Project responses preserve their existing fields and add:

```json
{
  "taskCounts": { "total": 4, "notStarted": 3, "inProgress": 0, "done": 1 },
  "completionPercentage": 25,
  "lateCount": 3,
  "blockedCount": 1
}
```

Deleted tasks are excluded. Zero active tasks means zero completion. Percentages
are rounded to two decimal places in responses; sorting uses the unrounded ratio.
Project queries add `hasLate=true|false`, `sort=completionPercentage` and
`sort=lateCount`; existing project defaults/search/sorts remain available. Items,
counts, filters and sorting share the same visibility scope and SQL snapshot.

## Domain rules and conflicts

A dependency means the dependent waits for the prerequisite. `C → B → A` means
C waits for both B and A. Self-edges, duplicate edges, cross-project links and
cycles are rejected. Reachability deduplicates shared ancestors and reports
shortest positive edge distance.

- Start: NotStarted → InProgress, only when every reachable prerequisite is Done.
- Complete: InProgress → Done.
- Reopen: Done → InProgress, only when no reachable dependent has ever started,
  including one already Done.
- `firstStartedAt` is retained on completion/reopening. No reset to NotStarted.
- Dependency additions/removals are rejected after the dependent starts.
- Name/dates remain editable after starting. Status, flags and IDs are read-only.
- Late: unfinished and end before today, or NotStarted and start before today.
  Today itself is not passed. Blocked: unfinished with any unfinished reachable
  prerequisite. Both flags can be true simultaneously.
- Deletion requires no active incoming dependents and removes outgoing edges
  transactionally. Deleting a dependent therefore removes its relationship to
  prerequisites; reopen considers the remaining active graph. Deleted rows stay
  for ID/history retention and disappear from ordinary reads.

Expected failures retain `{ code, message, requestId }`. Input failures are 400;
missing/hidden/path-mismatched resources are 404. Conflicts return 409 with
`TASK_STATE_CONFLICT`, `TASK_BLOCKED`, `TASK_DEPENDENTS_STARTED`,
`DEPENDENCY_LOCKED`, `SELF_DEPENDENCY`, `DEPENDENCY_EXISTS`, `DEPENDENCY_CYCLE`
or `TASK_HAS_DEPENDENTS`. Authentication, body limits and retryable database
failures follow the existing API contract.

## Persistence and concurrency

Migration 0005 adds tasks and dependency edges; migrations 0001–0004 remain intact.
Database checks enforce valid date ranges, status/start-history consistency,
positive/unique project-local numbers, unique public IDs, same-project edge
foreign keys, edge uniqueness and no self-edge. Acyclicity, transition rules,
deletion guards and counter allocation are coordinated by application transactions.

Writes acquire the session lock, then the project row lock, and recheck current
role/membership. Cycle, transition and deletion decisions run after that lock on
the same connection as mutations. All writers use this database coordination;
no process-local mutex substitutes for it. Coarse project locking intentionally
serializes task writers within a project while different projects can proceed.

Task reads decode a whole active project graph from one PostgreSQL statement,
then use iterative traversals and visited sets. Blocked propagation visits nodes
and edges once; task lists do not recursively query one task at a time. Project
summaries use scoped set-based SQL with recursive UNION deduplication of blocked
task identities. They do not load all company tasks into the API or enumerate
every possible path. Internal project authorization records remain separate from
the expanded screen projection.

The 3,000-task project size is a verification/performance target, not a creation
limit. Larger projects are accepted; their latency/memory usage is unqualified.
Full-company seed counts, resource-budget benchmarks and tuning remain Stage 5.

## Curl examples

Use an active [Stage 2 curl session](STAGE2.md#curl-walkthrough), before its logout
step, with the private `$stage2_curl_dir/headers` file containing the current
Bearer header. Replace the public IDs below with ones from your own responses.
These examples print task data, not session credentials:

```sh
stage3_project_id='REPLACE_WITH_YOUR_PROJECT_ID'
curl --fail-with-body --silent --show-error \
  -H "@$stage2_curl_dir/headers" -H 'Content-Type: application/json' \
  -d '{"name":"Prepare foundations","startDate":"2026-11-15","endDate":"2026-12-15"}' \
  "http://localhost:3000/api/v1/projects/$stage3_project_id/tasks"

stage3_task_id='REPLACE_WITH_CREATED_TASK_ID'
curl --fail-with-body --silent --show-error \
  -H "@$stage2_curl_dir/headers" -H 'Content-Type: application/json' -d '{}' \
  "http://localhost:3000/api/v1/projects/$stage3_project_id/tasks/$stage3_task_id/start"

curl --fail-with-body --silent --show-error \
  -H "@$stage2_curl_dir/headers" \
  "http://localhost:3000/api/v1/projects/$stage3_project_id/tasks/$stage3_task_id/prerequisites?page=1&pageSize=100"
```

To add a dependency before starting, POST `{"prerequisiteTaskId":"..."}` to the
dependent task's `/dependencies` route. A blocked Start returns 409. Rebuild the
private header file after refreshing the session; complete logout and remove
temporary credential files when finished.

Implementation references: the installed Effect 4.1.2 types and matching
`repos/effect/packages/effect/src/DateTime.ts`, the existing transactional SQL
patterns, and `tests/integration/race.ts` for deliberate separate-connection
overlap. The vendored reference is read-only.

## Verification

Verified across 14–15 November 2026:

| Check | Result |
| --- | --- |
| `nix develop --command just check` | Formatting, lint, type-checking, 52 unit tests and production build passed; zero lint errors and 28 non-blocking warnings |
| Real PostgreSQL suite | 35 integration tests passed against PostgreSQL 16.16 with normal durability explicitly enabled, including Stage 2 regression coverage, nine task cases and a retained Stage 2 migration upgrade; 205.62 seconds with unchanged timeouts |
| Domain laws | All transition pairs, chain/diamond distances, transitive blocking, started/completed dependent reopen guards, strict date boundaries and 20 generated DAGs compared with an independent all-pairs oracle |
| Company dates | Muscat midnight and named-zone daylight-saving cases passed; invalid/empty/offset timezone settings rejected |
| Concurrency | Opposite edge insertions, Start versus edge addition, Reopen versus dependent Start and deletion versus an incoming edge deliberately overlapped on separate database connections; final states checked |
| Authorization after waiting | Membership removal raced a task write; a separate role-change test made both queued writes return 404 without inserting tasks |
| IDs and constraints | Twelve concurrent creations produced unique IDs; independent project counters, values beyond 9999, non-reuse after deletion/restart and database FK/check/uniqueness rejection passed |
| Full project graph | All 2,999 prerequisites of a 3,000-task chain retrieved across 30 pages with correct distances; creation of task 3,001 succeeded |
| Summary correctness | Active counts, Late/Blocked, scoped metadata, empty pages, inclusive ranges and unrounded completion sorting passed |
| Fresh Compose | Final source built and started on an empty isolated volume, applied five migrations before readiness, and required no private bundle or manual migration; PostgreSQL `fsync` remained on |
| Curl/OpenAPI/Swagger | 37 HTTP checks passed plus bundled Swagger/spec comparison; task statuses, relationships, access checks, summaries, refresh and logout matched runtime |
| Restart/outage | API SIGTERM exited 0 in 1,163 ms; database-outage readiness returned 503 in 2,011 ms while liveness stayed 200; readiness recovered; full Compose down/up retained sessions, tasks and counters |
| Cleanup and scope | Temporary credential files removed; test schemas cleaned and temporary PostgreSQL servers stopped; rehearsal containers/networks removed with volumes retained; dependency pins, compiler and migrations 0001–0004 unchanged |

The first integration pass exposed an inefficient summary join on two projects
containing about 6,000 tasks. The query exceeded the five-second statement
deadline. Its recursive terms now join indexed base tables rather than repeatedly
joining a materialized task set. On an isolated 6,000-task diagnostic fixture,
`EXPLAIN (ANALYZE, BUFFERS)` measured 6.324 ms after the rewrite. This is one SQL
sample without the Stage 5 host budget or concurrency load, not a latency SLO.

That first run also encountered three DDL statement timeouts during disposable
schema setup. An earlier successful integration run disabled `fsync`, synchronous
commit and full-page writes only in its fresh temporary PostgreSQL cluster while
investigating suspected disk-sync pressure. On 15 November, a fresh-cluster retry
explicitly confirmed `fsync=on`, `synchronous_commit=on` and `full_page_writes=on`:
all 35 tests passed in 205.62 seconds with unchanged application and test
deadlines, real constraints and deliberate database locks. The database log
contained no statement timeouts, and cleanup left zero test schemas. The user
reported background workloads during the first run; contention remains a
possible explanation rather than a proven cause. Fresh Compose startup and
persistence were checked separately with normal durability settings. These
checks do not establish crash/power-loss recovery guarantees or qualify latency
at the full assignment dataset size.

Final verified API image ID:
`sha256:aa3bee70dd3400fda36790ff046acdef93d56aa90f19044d7a2b8311a9bc7592`.
The successful rehearsal volume is
`sitetrack-stage3-6d21c785_postgres_data`; preliminary startup volume
`sitetrack-stage3-8ce04c5f_postgres_data` was also preserved. Prior-stage volumes
were not reset or removed. Both Stage 3 rehearsals used unused loopback ports to
avoid the native development server's port 3000.

These results cover the Stage 3 portions of ID-01, DAG-01/02, TASK-01/02/03,
ACL-01/02, task deletion policy and startup/documentation behavior. No independent
security audit, full-company seed or resource-budget performance qualification
was performed. Production deployment readiness and inventory acceptance remain
outside this stage.
