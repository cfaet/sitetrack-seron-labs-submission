# SiteTrack — Implementation Specification

Version: 1.0 • 10 November 2026 • Owner: Fabrizio, CFMoon Software

Status: implementation baseline. This document specifies intended behavior for a software project.

## 1. Authority, purpose and scope

Build SiteTrack, a construction project and materials-tracking backend API, based on Seron Labs’ `SiteTrack-Backend-Assignment.pdf` document, dated 6 November 2026. A transcript for easy navigation of the aforementioned document is avaialable in Markdown format at `SiteTrack-Backend-Assignment-Transcript.md`

This specification is the authoritative implementation baseline for the project. The Seron Labs document, `SiteTrack-Backend-Assignment.pdf`, supplies the original requirements and screen guidance and may be consulted as supporting reference. Apply the explicit decisions below to unspecified details. If a substantive conflict with the PDF is discovered, record the discrepancy and proposed resolution for Fabrizio, continue independent work, and resolve it before accepting the affected feature. Ordinary implementation choices do not require permission or external clarification. Record material behavior changes in this specification and update affected contracts and tests together.

Labels:

- **REQ**: behavior required by the assignment.
- **DEC**: our chosen interpretation or implementation policy, adjustable with a recorded reason.
- **TARGET**: an engineering objective whose achievement requires measured evidence.

**REQ:** TypeScript, Go or Dart server; PostgreSQL; backend only; `docker compose up` starts API and database ready to use without manual setup. Deliver a Git repository with genuine progressive commits, API documentation, full-scale data loader and README explaining decisions and tradeoffs.

**DEC:** TypeScript with Effect 4, Node.js, explicit SQL and versioned migrations. One application and one database. REST/JSON with an OpenAPI contract. No frontend, microservices, external identity provider, Redis, message broker, cloud dependency or AI inference. Optional local Nix tooling must not be required by reviewers.

The product represents one company. Do not introduce organizations, billing, procurement, accounting, material consumption, project-to-project deliveries or additional task states.


## 2. Technical baseline and boundaries

Use matching, exact Effect package versions and a committed package-manager lockfile. Planning baseline is Effect 4.1.2; verify availability and API compatibility before scaffolding. Do not mix v3 documentation/imports with v4. Use supported, pinned Node and PostgreSQL versions; record actual versions in README. Do not use mutable `latest` image tags.

Initial dependencies: `effect`, `@effect/platform-node`, `@effect/sql-pg`; development tests use Vitest and `@effect/vitest`. HTTP and SQL abstractions are under `effect/http-api`, `effect/http` and `effect/sql`. Use current v4 documentation. An ORM is not required; introducing one requires a concrete benefit and a compatibility check.

Boundaries:

1. **HTTP contracts/handlers:** decode requests, authenticate, call an application operation, encode a declared response/error. No direct inventory or graph mutation logic here.
2. **Application services:** orchestrate permissions, current-state reads, domain decisions and transaction boundaries.
3. **Pure domain:** deterministic validation and decisions, explicit inputs and outputs. No database, network, environment, ambient time or logging.
4. **Repositories:** parameterized SQL, row decoding, constraints and locking. No HTTP status decisions.
5. **Composition:** Effect Context services and Layers connect implementations. Run the application at its entry point; avoid nested ad hoc runtimes.

Effect types describe results, expected errors and required services. They do not prove totality, correct authorization or correct concurrency. Database transactions do not make operations automatically idempotent or business-correct.

Suggested layout: `src/main.ts`, `src/config/`, `src/api/`, `src/domain/`, `src/services/`, `src/repositories/`, `src/db/migrations/`, `src/seed/`, `tests/`. Keep feature contracts together where this improves navigation. Avoid interfaces and abstractions without a real boundary.

## 3. Shared representations

**DEC:** JSON field names are camelCase; SQL names snake_case. Use UUID internal identifiers where helpful and immutable human-readable project/task IDs externally. Never treat an unguessable identifier as authorization.

- Planned dates are validated Gregorian `YYYY-MM-DD` dates, stored as PostgreSQL `date`. Start date must be on or before end date. Task date ranges need not fit inside project dates; the PDF does not require that restriction.
- Event timestamps are UTC instants, stored as `timestamptz` and returned as ISO 8601 strings.
- “Today” uses one documented company timezone, default `Asia/Muscat`. Derive it once per operation and pass it into domain functions. Compare dates strictly: a date is passed when it is earlier than today.
- Quantities use PostgreSQL `numeric(20,6)` and canonical decimal JSON strings. No binary floating-point arithmetic for stock. Validate scale, range and positivity before mutation. Reorder points may be zero; delivery/add-stock amounts must be positive.
- Validate nonempty trimmed names, bounded string lengths and request-body size. Normalize email consistently for case-insensitive uniqueness; preserve display name separately. Publish limits in API docs.
- Public IDs have a minimum four-digit numeric component; continue beyond 9999 rather than silently truncating. Pagination uses internal immutable identifiers as tie-breakers.

## 4. Core state and persistence

Minimum relational entities:

| Entity | Essential data / constraints |
| --- | --- |
| User | Unique normalized email, password hash, name, exactly one app role |
| Session | User, revocation timestamp, expiry, hashed refresh credentials |
| Project | Immutable unique sequence/public ID, name, planned dates, task counter, deletion marker |
| Membership | Unique `(project,user)`, project-admin boolean |
| Invitation | Project, inviter, invitee, pending/accepted/rejected/withdrawn, timestamps |
| Notification | Recipient, invitation reference, read timestamp, creation timestamp |
| Task | Project, unique local sequence/public ID, planned dates, status, first-start timestamp, deletion marker |
| Dependency | Unique `(dependent, prerequisite)` within one project |
| Material | Name, category, unit, deletion marker |
| Store | Exactly one company store; exactly one store per project |
| Stock | Unique `(store,material)`, nonnegative quantity; company reorder point |
| Delivery | Project, direction, status, sender, initiation time, terminal action actor/time |
| Delivery line | Unique `(delivery,material)`, positive immutable quantity |
| Stock movement | Immutable signed delta, store, material, cause/action reference and actor |
| Idempotency record | Unique actor/operation/key, normalized request fingerprint and saved outcome |

Stock balances and movements are written together in the same transaction. Movements provide reconciliation history, not a separate event-sourcing architecture. Add foreign keys, uniqueness, checks and indexes through migrations. Use composite relationships to prevent cross-project dependency edges. Describe which invariants remain application-enforced.

**DEC deletion policy:** projects, tasks and materials are soft-deleted to retain references and ID history. Deleted resources disappear from ordinary reads and reject new operations. Reject project deletion while it has stock or in-transit deliveries. Reject task deletion while another active task depends on it; allow explicit removal of eligible edges first. Deleting a task removes its outgoing dependency edges transactionally. Reject material deletion while any stock is positive or a delivery is in transit; preserve historical delivery-line name/unit snapshots. Reject unit changes once stock/history exists. Repeated deletion of a now-hidden resource returns 404.

## 5. Access control

**REQ:** any person registering may select any one of the application roles: `User`, `CompanyStoreManager` or `SuperAdmin`. No invitation, existing administrator approval or privileged-role provisioning step is required. After registration, enforce the permissions of the selected role normally.

| Operation | Allowed actor |
| --- | --- |
| Create project | Any authenticated user; creator becomes its first admin/member |
| Read project and project screens | Current member, or SuperAdmin |
| Edit/delete project | Project admin (DEC) |
| Manage tasks/dependencies | Project member, or SuperAdmin |
| Read/manage shared material catalogue | Any authenticated user |
| Invite/withdraw/promote/remove members | Project admin only |
| Accept/reject invitation | Its invitee only; must still be pending |
| Read company stock or company-wide delivery list | CompanyStoreManager or SuperAdmin |
| Add company stock/set reorder point | CompanyStoreManager or SuperAdmin |
| Initiate company → project delivery | CompanyStoreManager or SuperAdmin |
| Initiate project → company delivery | Project member or SuperAdmin |
| Record/reject delivery | Actor authorized for destination store |
| Cancel in-transit delivery | Actor authorized for source store (DEC: not restricted to original initiator) |

**Important:** SuperAdmin has all-project data access, but this baseline does not silently grant project-admin-only membership powers. A SuperAdmin needs project-admin membership for those operations. No public application-role-change endpoint is required. Test current-role changes through fixtures/database updates and ensure they take effect on the next request.

**REQ:** callers without project visibility receive the same 404 response as for a nonexistent project, including nested reads and mutations. Apply visibility restrictions to counts, search, sorting and reports too. **DEC:** a caller who may see the project but lacks permission for an action receives 403; for example, an ordinary member attempting to invite another member. An invitation notification exposes only the minimal invitation/project summary needed to decide; it does not grant project access.

**DEC cross-store boundary:** project members may read deliveries belonging to their project, including their company-store endpoint identity, but cannot read company balances or other projects. Store managers may view project identifiers/names and line details needed to address deliveries through company-store endpoints; this narrowly scoped projection grants no project-task/member access. Document this necessary operational interpretation.

Check current DB role, session and membership on every request. Do not trust role/membership claims embedded in an old JWT. Do not cache access decisions across requests. Recheck authorization inside write transactions after acquiring relevant locks.

## 6. Authentication and invitations

**REQ:** register, log in, log out, own profile; JWT authentication; active users need not repeatedly enter credentials; the logged-out session stops working.

**DEC:** access JWTs expire after 15 minutes; opaque rotating refresh tokens have 7-day idle and 30-day absolute session expiry. Return expiry metadata. Refresh extends idle expiry only within absolute expiry. Store only refresh-token hashes. JWT includes subject, session ID, issuer, audience, expiry and token purpose; verify signature, fixed allowed algorithm and claims. A valid JWT still requires an active session in DB. Logout revokes that session and its refresh credentials; other sessions remain active. Define refresh/logout races so a revoked session cannot be revived. Serialize refresh rotation per session; reused rotated credentials fail.

**DEC session timestamp validation:** decode idle and absolute expiry as finite epoch-millisecond numbers before comparisons. Non-finite stored deadlines are invalid database data and produce the existing generic 500 response without authenticating or rotating refresh credentials; ordinary expired/revoked sessions remain 401. No invalid value is replaced with a fallback deadline.

Use a maintained password-hashing implementation with an appropriate password KDF and documented parameters; never design cryptography. Normalize failed login responses and avoid an obvious missing-user fast path. Never expose hashes or log passwords, refresh tokens, JWTs or connection credentials. Apply bounded login/registration throttling suitable for a single process; document its restart/multi-instance limitation.

Invitations target existing registered users by normalized email. Creating an invitation and its notification is atomic. At most one pending invitation per project/invitee; reject inviting existing members. No self-invitation. Answered/withdrawn invitations cannot be answered again. Acceptance inserts membership with `isAdmin=false` and changes state atomically. Withdrawal and acceptance race: exactly one wins. Project-admin removal or demotion must preserve at least one admin; reject the operation otherwise. Demotion is supported as an explicit DEC with the same invariant.

Notifications are newest first. Read/unread is independent of invitation status; answering an invitation marks that notification read. Expose a recipient-scoped unread count. No push service is required.

## 7. Identifiers

**REQ:** project IDs count upward company-wide; task IDs count upward within their project. They never change or get reused after deletion; concurrent creation cannot duplicate them.

**DEC:** global project numbers use a PostgreSQL sequence. Local task numbers use an atomic per-project counter update in the task-creation transaction. Add uniqueness constraints in both cases. Gaps are permitted; no requirement promises gapless numbering. Never allocate with `MAX(id)+1` or an in-memory counter. Never reset counters on deletion, restart or normal seed execution. Reset only in an explicitly destructive test/reset command.

## 8. Task and graph semantics

Use one orientation consistently: `(dependentTaskId, prerequisiteTaskId)` means the dependent waits for the prerequisite. In documentation, `A → B` means A depends on B. External UI arrows may use the opposite orientation; API field names remove ambiguity.

**REQ:** same-project edges only; no self-edge or directed cycle; transitive dependencies count. **DEC:** reject duplicate edges as a conflict. Ancestor/dependent details return each task once and use shortest positive edge distance when more than one path exists.

Let `prerequisites(t)` contain every reachable prerequisite and `dependents(t)` every reachable dependent:

- `blocked(t) = status(t) != Done AND exists p in prerequisites(t): status(p) != Done`.
- `late(t,today) = status(t) != Done AND (endDate(t) < today OR (status(t) = NotStarted AND startDate(t) < today))`.
- New task status is `NotStarted`.
- Start: `NotStarted → InProgress` only if every reachable prerequisite is Done.
- Complete: `InProgress → Done`.
- Reopen: `Done → InProgress` only if no reachable dependent has ever started.
- Reject all other transitions. Late and Blocked are computed, never writable fields.

**DEC:** retain `firstStartedAt` even after completion/reopening. “Has started” includes a dependent already Done. No manual reset to NotStarted. Reject dependency additions/removals when the dependent has started; this avoids changing prerequisites retrospectively. Changes to dates/names remain allowed with normal validation. Allowed actions in task details reflect current graph/state but are advisory: commands validate again transactionally.

Serialize task graph mutations, task status actions and related deletion within a project by locking its project row. Perform cycle/reachability checks after acquiring that lock on the same transaction connection. This coarse lock is intentional for the 3,000-task/project verification and performance target; it is not a product creation limit. Performance beyond that size is unqualified. Document contention tradeoffs. Never rely only on a preflight check outside the transaction.

## 9. Stock and delivery semantics

**REQ:** new stock enters only through company-store additions. Deliveries contain one or more materials and run only company ↔ project, never project ↔ project. A delivery cannot be edited after initiation.

| Command | Allowed state | Atomic changes |
| --- | --- | --- |
| Add stock | Positive amount, active material | Increment company balance; append movement |
| Initiate | Authorized source, all amounts available | Subtract every source amount; insert InTransit delivery and immutable lines; append source movements |
| Record | InTransit, authorized destination | Change to Delivered; increment destination balances; append destination movements; record actor/time |
| Reject | InTransit, authorized destination | Change to Rejected; refund source balances; append refund movements; record actor/time |
| Cancel | InTransit, authorized source | Change to Cancelled; refund source balances; append refund movements; record actor/time |

Terminal deliveries never transition again. Delivery commands do not partially succeed. Disallow duplicate material lines rather than silently combining them. Validate quantity upper bounds to prevent numeric overflow.

Use one lock order for inventory operations: affected material rows in sorted ID order, relevant project row when applicable, delivery row for terminal actions, then affected stock rows in sorted `(storeId, materialId)` order. Material reads for stock additions, initiation and terminal actions acquire a shared row lock and recheck active/unit state; deletion and unit changes take an exclusive lock on that same material row before checking balances/history. This prevents a material from being deleted or its unit changed while stock operations are using it. Project locks coordinate project deletion/membership changes with deliveries. Create absent stock rows with conflict-safe inserts in the same deterministic order where required. Use locked balances or conditional updates and DB nonnegative constraints; never read-check-write in separate transactions. Task-only commands need only the project lock. No operation may take an earlier-ranked lock after a later-ranked lock.

Session authorization locks precede these inventory locks. When supplied, claim the idempotency key with a transaction-scoped advisory lock after the session lock and before material locks. Inventory uses its own transaction orchestration; do not acquire material locks after the existing project-only transaction helper. Recheck current role/membership after relevant waits and before mutation or replay.

Terminal-action races must have one winner: record vs cancel cannot both change stock. The other command observes a terminal state and returns conflict. Serialize retries using idempotency keys, not by retrying arbitrary side effects blindly.

**DEC quantity overflow:** reject an addition, receipt or refund that would exceed a stored balance's `numeric(20,6)` range with 409 `QUANTITY_OVERFLOW`, rolling back the entire command. The delivery remains InTransit after a failed terminal action. Do not reserve capacity upfront; stock must move before retrying a capacity-conflicting action. Derived totals may exceed a single balance's bound and remain exact decimal strings.

**DEC idempotency:** support an optional `Idempotency-Key` on stock additions, delivery initiation and delivery terminal actions. Requests without it remain valid and execute as distinct commands; they do not receive automatic retry deduplication. Scope keys by authenticated user and operation kind; include target resource IDs and normalized input in the request fingerprint. Same key and fingerprint returns the stored success without repeating movements; different target or payload returns conflict. Claim/serialize the key before executing the mutation, and store the successful outcome in the same transaction. Failed/rolled-back operations do not consume a success key. Reauthorize before returning a saved response. Preserve successful keys for the assignment’s lifetime; expiry policy is deferred. Terminal delivery state guards apply with or without a key: state conflicts without a matching completed key return 409.

Company stock status: zero → OutOfStock; above zero and at/below reorder point → LowStock; above reorder point → Available. Transit quantity counts only InTransit company-to-project lines. Read balance plus transit values consistently for each response.

**DEC conservation invariant:** per material, total balances across stores plus all InTransit quantities equals cumulative supplier additions. Delivered/Rejected/Cancelled lines are not transit inventory. No stock adjustment/consumption endpoint exists. Movement reconciliation must agree with stored balances.

## 10. API contract

Effect HTTP API contracts are the executable request/response definitions; generate OpenAPI documentation from them alongside endpoints. Use a versioned `/api/v1` prefix. Mutations use explicit commands rather than allowing unrestricted status patches. Collection responses are `{ items, pagination }`; errors are `{ code, message, requestId }`. Do not expose SQL, stack traces, hashes or hidden-resource details.

| Group | Minimum endpoints (relative to `/api/v1`) |
| --- | --- |
| Auth | POST `/auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`; GET `/me` |
| Notifications | GET `/notifications`, `/notifications/unread-count`; POST `/notifications/{id}/read` |
| Projects | GET/POST `/projects`; GET/PATCH/DELETE `/projects/{projectId}` |
| Membership | GET `/projects/{projectId}/members`; PATCH/DELETE `.../members/{userId}` |
| Invitations | GET/POST `/projects/{projectId}/invitations`; POST `.../invitations/{id}/withdraw`; POST `/invitations/{id}/accept`, `/invitations/{id}/reject` |
| Tasks | GET/POST `/projects/{projectId}/tasks`; GET/PATCH/DELETE `.../tasks/{taskId}` |
| Task commands | POST `.../tasks/{taskId}/start`, `/complete`, `/reopen` |
| Dependencies | POST `.../tasks/{taskId}/dependencies`; DELETE `.../tasks/{taskId}/dependencies/{prerequisiteId}` |
| Materials | GET/POST `/materials`; GET/PATCH/DELETE `/materials/{materialId}` |
| Project store | GET `/projects/{projectId}/store`; GET/POST `/projects/{projectId}/deliveries` (POST means return to company) |
| Company store | GET `/company-store/stock`; POST `/company-store/stock/additions`; PUT `/company-store/stock/{materialId}/reorder-point`; GET/POST `/company-store/deliveries` |
| Delivery commands | GET `/deliveries/{id}`; POST `/deliveries/{id}/record`, `/reject`, `/cancel`, with direction-aware authorization |

Creating a company delivery accepts a destination project ID but does not grant arbitrary project lookup. Project paths verify a task/invitation/member belongs to the named project. Delivery lookup evaluates visibility before exposing existence.

Status mapping: malformed/invalid input 400; missing/invalid/revoked authentication 401; forbidden nonhidden operation 403; nonexistent or hidden project-scoped resource 404; state/uniqueness/idempotency conflict 409; unexpected fault 500 with generic message. Successful creates 201; reads/updates/commands 200; deletes/logout 204. Use declared error unions and document codes.

Pagination: `page` starts at 1, `pageSize` defaults to 25 and caps at 100. Use deterministic sort plus immutable tie-breaker. Offset pagination is an explicit simplicity tradeoff; benchmark deep pages. Counts and filters must have the same access scope as items. Reject unknown sort/filter fields and never interpolate raw client sort strings into SQL.

## 11. Screen completeness

Every collection is paginated. Task relationship details support the full 3,000-task project size without silently truncating reachable tasks. Bound delivery creation to 100 distinct material lines and document that limit; reject excess lines before writing. Bound request bodies and string fields explicitly. Prohibit unbounded company-wide nested expansions.

| Screen | Required projection / controls |
| --- | --- |
| Projects | Public ID, name, dates, caller’s admin flag, member count, task status counts, completion percentage, late/blocked counts; search name/ID; filter has-late; sort name/start/completion/late |
| Project tasks | Public ID/name/dates/status/flags, direct prerequisites, direct-dependent count; filter status/late/blocked/date range; search name/ID; sort ID/name/start/end/dependent count |
| Task detail | Task, currently allowed actions, all reachable prerequisites and dependents with shortest distance |
| Project store | Material, quantity, unit, last successful delivery activity timestamp; search name, category filter; sort name/quantity/last delivery |
| Project deliveries | Incoming/outgoing direction, status, immutable lines, sent/received dates, sender/receiver; filter direction/status/date; newest first |
| Project members | Current members/admin flags and pending invitations; invite/withdraw/promote/demote/remove controls based on permissions |
| Company stock | Material, quantity/unit, outgoing in-transit quantity, reorder point/status; filter status/category; search name; sort name/quantity/status |
| Company deliveries | Project summary, direction/status/lines/sent/received dates; filter project/direction/status/date; newest first |
| Notifications | Recipient-only invitations, state/allowed answers, read flag; newest first and unread count |

**DEC:** completion is `100 * done / activeTaskCount`, zero when there are no active tasks; display rounded to two decimals but sort by the underlying ratio. Planned-range filter means inclusive interval overlap. Delivery date filtering uses initiatedAt; inclusive UTC calendar dates are implemented as a half-open instant range from the first date at 00:00 through the day after the final date at 00:00. `receivedAt` is populated only for Delivered; separate `closedAt`/`closedBy` records rejection/cancellation. Last-delivery activity includes initiation, successful recording and refund actions affecting that store’s stock. Company stock status order is OutOfStock, LowStock, Available. Project stock lists balance rows, including historical zero rows, not the entire catalogue. Company stock lists every active catalogue material, defaulting absent balance/reorder point to zero.

## 12. Scale and performance

**REQ seed minimums:** 5,000 users; 2,000 projects with up to 50 members; 50,000 invitations; 500,000 tasks with up to 3,000/project; 1,000,000 dependency edges; 20,000 materials; 400,000 deliveries with 3,000,000 lines.

Provide deterministic `seed:small` and explicit `seed:large` commands runnable inside Compose, documented with expected runtime/storage. Large seed creates varied roles, memberships, invitation states, dates, statuses, valid DAGs, both delivery directions and terminal states. Generate statuses compatible with prerequisite rules and balances compatible with inventory history. Use batched/COPY-style loading rather than millions of HTTP calls. Reconcile seed invariants and synchronize counters with loaded IDs. Never overwrite an existing database without an explicit reset option and warning.

Index access paths, including membership by user/project; invitation recipient/state/time; tasks by project and common sort/filter fields; edges in both directions; balances by store/material; delivery project/status/time; line delivery/material references; session and idempotency lookup keys. Add indexes based on actual plans, not every possible column permutation.

Use set-based summaries and scoped graph traversal; avoid N+1 repository calls, per-row recursive requests, and loading 500,000 tasks into the API. Do not enumerate all graph paths: deduplicate reachability and compute shortest distances. A transitive-closure table is not the default because dense graphs can expand dramatically. Derived flags must reflect current state and date; cached summaries need an explicit invalidation strategy before adoption.

**TARGET measurement baseline:** on a documented 2-vCPU/4-GiB host or equivalent container budget, with API and DB sharing the budget, aim for warm common-page p95 ≤500 ms at 10 concurrent clients, and worst-project detail/graph p95 ≤1 s. These are tuning targets rather than additional assignment pass/fail thresholds. Report dataset distribution, machine limits, warmup, sample count, error rate, cold/deep-page behavior and actual timings. Capture representative `EXPLAIN (ANALYZE, BUFFERS)` plans and optimize observed bottlenecks. Document any missed target and its tradeoff rather than expanding infrastructure to meet an invented requirement.

## 13. Verification requirements

| ID | Acceptance evidence |
| --- | --- |
| AUTH-01 | Failed login has generic response; hashes/secrets absent from outputs |
| AUTH-02 | Logout invalidates access JWT and refresh for that session; other sessions survive |
| AUTH-03 | Role/member removal affects the next request, without token reissue |
| ACL-01 | Outsider gets equivalent 404 for real/absent project IDs and nested resources |
| ACL-02 | Search/counts/sorts/reports never include another project’s data |
| ACL-03 | Store manager’s delivery projection does not expose project tasks/members |
| INV-01 | Concurrent acceptance/withdrawal has exactly one winner |
| MEM-01 | Concurrent admin removals/demotions cannot leave zero admins |
| ID-01 | Parallel project/task creation produces unique monotone IDs; restart/deletion does not reuse issued IDs |
| DAG-01 | Self/cross-project/cyclic edges rejected; chain/diamond distances correct |
| DAG-02 | Competing edge insertions cannot jointly introduce a cycle |
| TASK-01 | All transition pairs tested; Start checks transitive prerequisites |
| TASK-02 | Reopen rejected with started or completed reachable dependent |
| TASK-03 | Late boundary dates and simultaneous Late+Blocked tested |
| STOCK-01 | Parallel withdrawals never create negative stock; insufficient multi-line delivery rolls back all changes |
| DEL-01 | Competing record/reject/cancel commits one terminal outcome and one stock effect |
| DEL-02 | Retry with same idempotency key produces one effect; different payload conflicts |
| DEL-03 | Both directions, conservation and movement reconciliation verified |
| STOCK-02 | Racing material deletion/unit changes with inventory operations preserves active-material and unit consistency |
| DELETE-01 | Referenced/history-sensitive deletion and nonempty project deletion obey policy |
| BOOT-01 | Fresh `docker compose up` requires no manual migration or environment-file copy |
| BOOT-02 | Restart preserves data; migrations apply once; broken migration prevents serving |
| SCALE-01 | Large seed reaches all minimum counts and invariant checks pass |
| PERF-01 | Screen queries benchmarked with published conditions and actual results |
| DOC-01 | OpenAPI and examples match actual endpoint responses and errors |

Use unit/property tests for pure domain laws and real PostgreSQL integration tests for SQL, constraints and concurrency. Race tests use separate connections/transactions with deliberate synchronization; sequential calls do not prove concurrent correctness. Tests asserting no leaks must exercise collection metadata as well as item endpoints. Do not replace Postgres with SQLite for integration evidence.

Useful properties: adding a legal edge preserves acyclicity; distance is shortest; start implies all prerequisites Done at its transaction point; stock conservation holds across every delivery command; repeated successful idempotent command leaves state unchanged; forbidden transitions leave state unchanged.

## 14. Staged execution and ownership

| Stage | Scope / exit gate |
| --- | --- |
| 1 — Foundation | Exact dependency lockfile, strict TS, Compose/Docker, config, pooled DB, migration mechanism, health/live+ready, initial OpenAPI/docs, shutdown, startup/integration tests |
| 2 — Identity/access | Auth/session lifecycle, projects, current-role access checks, memberships and invitations; pass AUTH/ACL/INV/MEM tests |
| 3 — Tasks | Stable IDs, domain rules, dependency graph, graph locking, screen projections; pass ID/DAG/TASK tests |
| 4 — Materials/deliveries | Catalogue, balances/movements, atomic deliveries and idempotency; pass STOCK/DEL/DELETE tests |
| 5 — Scale/submission | Deterministic full seed, query plans, benchmarks, complete docs and clean-machine rehearsal |

Stage 1 must run with `docker compose up` alone (without a mandatory prior build command), using `build:` as needed. Validate required config; use explicitly local-only Compose defaults for reviewer convenience, not hardcoded production secrets. Wait for DB readiness, apply migrations before listening, and fail with a nonzero exit on unrecoverable startup failure. Bind API to `0.0.0.0`; keep DB internal by default. Expose `/health/live`, `/health/ready`, `/openapi.json` and `/docs`. Readiness returns 503 on bounded DB-check failure without leaking details. Configure structured logs and request IDs. Keep a small pool appropriate to the shared server. Large seed is never part of startup.

**DEC development commands:** Just is an optional thin wrapper over canonical npm scripts. Provide `dev`, `start`, `typecheck`, `build`, `test`, `test-watch`, `lint`, `lint-fix`, `fmt`, `fmt-check`, and `check` recipes, with the default recipe listing commands. `start` requires an explicit prior build. `check` runs a non-writing format check, lint, type-checking, unit tests, then production build sequentially and stops on failure. Lint errors block; warnings remain visible and non-blocking. Formatting writes and lint fixes are separate explicit commands, never part of `check`. Vitest discovers only `tests/**/*.{test,spec}.ts`, excludes vendored sources and generated output, and fails when no tests exist; an empty suite must not make the aggregate check green. Recipes and npm scripts inherit the caller's environment without automatic dotenv loading. Add database and Compose commands only alongside working implementations; document commands and current limitations in README.

**DEC linting and formatting:** pin `@effect/tsgo` 0.69.0, Oxlint 1.93.0, `oxlint-tsgolint` 7.0.2006 and Oxfmt 0.78.0. Use the `effect-tsgo oxlint --type-aware` wrapper with the Effect recommended preset; preserve the stock TypeScript compiler and avoid install-time patch hooks. Lint first-party TypeScript only. Format first-party TypeScript and the selected root JSON configurations with two spaces, double quotes, no trailing commas, semicolons omitted where safe, 120-column width, LF and a final newline. Disable import/package-key sorting and embedded-language formatting. Exclude vendor, generated, private and local tooling files and lockfiles; Markdown/YAML are outside the formatting pass. Ordinary lint fixes require an explicit command and diff review; suggestion/dangerous fixes are not enabled.

**DEC unstable Effect APIs:** the application intentionally uses APIs marked unstable, including HTTP, SQL and crypto. Disable only `effecttsgo/unstable-api-usage` project-wide to suppress repeated notices of this accepted compatibility risk. Keep exact dependency pins; review upstream compatibility changes and run relevant checks before accepting upgrades. Keep `effecttsgo/experimental-api-usage` enabled at its recommended warning severity and preserve all other configured diagnostics. Remaining warnings stay visible and non-blocking; lint errors still fail checks.

**DEC schema decoders:** use typed decoders when the input already matches a concrete schema's Encoded type; runtime validation and failure handling remain required. Keep unknown-input decoders at the generic HTTP-body and database-row boundaries. Their `Schema.Constraint` exposes Encoded as unknown, so a typed decoder adds no useful input guarantee there. Document a line-level `effecttsgo/prefer-typed-schema-decoder` exception at each of those two calls; keep the rule enabled elsewhere and do not cast external inputs to satisfy it.

**DEC Stage 3 task contracts:** tasks use the existing 200-character name/date validation and immutable project-local public IDs. Creation returns NotStarted; PATCH accepts name/dates only. Status commands use empty JSON objects and return current allowed actions. Task and dependency state conflicts use explicit 409 codes; wrong-project tasks and prerequisites return 404. Direct prerequisite references and dependent counts accompany task rows. Paginated `/tasks/{taskId}/prerequisites` and `/dependents` include all reachable tasks with shortest positive distance, ordered by distance then numeric task ID. Task query fields are `status`, `late`, `blocked`, `fromDate`, `toDate`, `search`, `sort`, `direction`, `page`, `pageSize`; boolean flags accept literal `true`/`false`, range endpoints use inclusive overlap, and the default sort is numeric ID ascending. Other task sorts are `name`, `startDate`, `endDate`, `dependentCount`. Project responses add `taskCounts` (`total`, `notStarted`, `inProgress`, `done`), `completionPercentage`, `lateCount`, `blockedCount`; project queries add `hasLate` and sorts `completionPercentage`/`lateCount`. Compute scoped project summaries with set-based SQL, not company-wide graph expansion in the API. API-only `COMPANY_TIME_ZONE` defaults to `Asia/Muscat`, validates a named zone before database startup, and is independent of database CLI configuration. Capture one instant per date-sensitive operation. Graph traversal uses iterative queues and visited sets, never path enumeration. Migration 0005 adds tasks/edges without rewriting retained migrations. This stage completes the task projections deferred at Stage 2; inventory and scale qualification remain later stages.

**DEC Stage 1 foundation:** split Vitest into database-free `unit` and explicitly invoked `integration` projects. Ordinary `test`/`check` select `unit`; `test:integration` requires `TEST_DATABASE_URL` and `SITETRACK_TEST_DISPOSABLE=true` without development fallback. The approved native integration target is local `sitetrack_test` with login role `sitetrack_test`. Verify connected identity before writes; create a unique schema per run and remove only that schema after checking its original OID. Never reset either retained database. Development uses `sitetrack` with its matching role. Read-only `db:check`/`db:test:check` report identity, version and migrations; `db:migrate` and normal startup share the same ordered migration runner. Initial schema objects are the migration ledger and global project-number sequence; business tables arrive with their stages.

**DEC configuration and secrets:** require an explicit redacted `DATABASE_URL`; accept TCP PostgreSQL URLs with explicit host/role/database and no query parameters or fragments. Default `DATABASE_SCHEMA=sitetrack`, `HOST=0.0.0.0`, `PORT=3000`; schema names are restricted lowercase identifiers. Use a five-connection pool with 2-second acquisition, 3-second connect and 5-second statement/lock limits. The database-startup phase has a 30-second deadline; retry only retryable availability probes, never arbitrary migration effects. Construct the HTTP listener only after migrations finish. Bound readiness to 2 seconds and graceful shutdown to 10 seconds. Native credentials stay in separate owner-managed SOPS-encrypted bundles at `secrets/dev.enc.env` and `secrets/test.enc.env` inside the repo-local `secrets/` directory, excluded from Git and the Docker build context and injected by explicit launches. Private keys remain separately managed. Reviewer Compose uses independent public local-only demo credentials and an internal database port; it requires no SOPS, keys or environment-file copy. Preserve volumes on ordinary shutdown. Pin Node/PostgreSQL images and document actual verification separately from implementation claims.


**DEC Stage 2 browser sessions and inputs:** return access JWTs only in JSON and
put rotating refresh credentials only in a host-only HttpOnly `sitetrack_refresh`
cookie, SameSite=Lax, path `/api/v1/auth`, with expiry bounded by idle/absolute
session deadlines. `AUTH_JWT_SECRET` is required by the API, redacted, canonical
base64url and at least 32 decoded bytes; no native default. `AUTH_COOKIE_SECURE`
defaults true, explicitly false for local HTTP Compose. `AUTH_ALLOWED_ORIGINS`
is an exact comma-separated allowlist, defaulting to localhost/127.0.0.1 origins
on port 3000. Credentialed CORS and a required `X-CSRF-Protection: 1` header on
all JSON auth POSTs protect the cookie flows; any supplied Origin must be trusted.
Support same-site browser deployments and cookie-jar curl clients. Auth responses
and own profile, including errors, use no-store. Logout is Bearer-authenticated
and revokes that session; clients refresh expired access tokens first.

**DEC Stage 2 security implementation:** use the installed Effect JWT API with
HS256, issuer `sitetrack`, audience `sitetrack-api`, typ `at+jwt`, required identity,
session, issued/expiry/token-ID claims and access purpose; bound tokens to 8 KiB.
Store only SHA-256 refresh hashes. Serialize rotation/logout by session-row locks;
old credentials fail without revoking or clearing a winning rotation. Use Effect
Argon2id on the pinned Node runtime: 64 MiB, three passes, one lane, random 16-byte
salt and 32-byte result, versioned storage and constant-time comparison. Bound
password work to two active plus eight waiting. Throttle login globally at
120/minute and per peer IP at 20/five minutes; registration at 30/minute globally
and five/minute per IP. Global admission precedes per-IP state; ignore forwarded
IP headers. Limits are process-local, return 429/Retry-After and reset on restart.

**DEC Stage 2 boundaries:** normalize email by trim/lowercase and trim names;
preserve passwords exactly, length 15–128 Unicode code points. Limit display names
to 120 UTF-16 code units, project names to 200, emails to 254, JSON bodies to
16 KiB and page numbers to 1,000,000. Unknown fields fail. Add new migrations
0002–0004 without changing migration 0001. Create project/first admin/empty store
atomically and provision the singleton company store through migration. Project
writes lock session, project, then invitation as needed and recheck access after
project locking. Soft deletion withdraws pending invitations. Stage 2 project
projections include identity/name/dates/admin flag/member count; task summaries,
has-late and task-based sorts await Stage 3. Company-store projections and ACL-03
await Stage 4. This staging does not weaken final screen/deletion requirements.

Fabrizio is project lead and reviews the resulting architecture, domain behavior and code. Agents may implement every module, including pure task-state rules and graph algorithms. Agree exported contracts before parallel work. Domain code uses validated immutable inputs and explicit `today`; failures are explicit values, with no hidden I/O.

Agent tasks must state scope, owned paths, inputs/contracts, relevant acceptance IDs and verification. Parallelize independent work after shared contracts/schema are agreed. One integrator coordinates migrations, transaction boundaries and final merges. Keep meaningful incremental commits and report completed work and verification concisely.

**DEC Stage 4 contracts:** migration 0006 adds inventory without rewriting earlier migrations. Quantities use exact bigint millionths in pure code, `numeric(20,6)` in storage, and canonical decimal strings on HTTP. Plain string inputs have at most 14 integral and 6 fractional digits; reject signs, exponents, whitespace, excess precision and JSON numbers. Aggregate quantities are not restricted to one stored balance's upper bound. Catalogue name/category/unit are trimmed and bounded to 200/100/40 UTF-16 code units; free-text categories/units and duplicate names are allowed. Unit changes stop once a balance row or delivery/movement history exists, including a balance created by setting a reorder point. Materials and deliveries use UUIDs. Delivery responses retain material-name/unit snapshots, minimal project/actor projections, UTC receipt/closure metadata and advisory store-side actions. Project delivery routes are `/projects/{projectId}/deliveries`; direction is always CompanyToProject/ProjectToCompany. Retry keys accept 1–128 letters/digits or `._:-`; normalized fingerprints include target IDs and material-sorted lines. Save only successful outcomes in the mutation transaction; matching retries return the original snapshot after current authorization, and GET returns current state. Include PUT and Idempotency-Key in CORS. Full-company seeds and resource-budget qualification remain Stage 5.

**DEC Stage 5 tooling:** migration 0007 records versioned small/large seed manifests. Seed only an explicitly opted-in empty application dataset; reuse only matching completed manifests after verification, refuse incomplete/incompatible data and preserve retained volumes. Use bounded bulk SQL with normal durability, exact movement history and independently checked actor sides, topology, counters and balance prefixes. Offline tools use a dedicated PostgreSQL session with a 300-second statement limit, five-second lock limit and dataset advisory lock; application limits remain unchanged. Optional isolated Compose profiles divide the shared budget into API 1 CPU/1 GiB and PostgreSQL 1 CPU/3 GiB, with a separately reported 1-CPU/512-MiB tools container. Just wraps canonical npm commands for seed/check/status, smoke/full benchmarks, actual-query plans and reports. Full measurement uses three repetitions of ten closed-loop clients, 20 warmup and 200 measured requests per case plus 60 seconds of mixed screens per repetition. Unexpected responses/incomplete samples fail; latency-target misses remain explicit results rather than new assignment thresholds. Benchmark first access is not an OS-cold-cache claim. Preserve ordinary setup-free Compose startup and private native configuration. See docs/STAGE5.md for commands and actual evidence.

**DEC Stage 5 query diagnostics:** focused measurement uses thirteen project/delivery/control cases, ten clients, one repetition, twenty warmup and fifty measured requests per case, without mixed traffic. It supplements the unchanged smoke/full protocols and does not establish full qualification. Project blocked counts are correlated to selected projects; derived status/date sorting and filtering still evaluate all visible candidates. Delivery totals and indexed page-ID selection share one SQL statement/snapshot, with detailed projections deferred to the page. Preserve exact totals and existing access/history rules. Database failures emit only fixed reason/category identifiers with request-ID log annotations; HTTP responses remain generic. No authentication/task behavior, pool limits, durability, schema or resource-budget changes belong to this optimization pass.

**DEC Stage 5 failure evidence:** distinguish failed benchmark verdicts from configuration errors. Preserve legacy aggregate report fields while separately reporting first-access, warmup and measured attempts/errors and failed-request IDs. Any request error, including warmup, still fails the benchmark; latency targets remain separate. Host wrappers capture bounded, time-scoped, allowlisted API/PostgreSQL diagnostic events even after tool failure and record unavailable sources explicitly. Never persist raw SQL, parameters, credentials or response bodies. Record host pressure snapshots as diagnostic context, without changing measurement protocols or asserting causality from host load alone.

**DEC Stage 5 audit diagnosis:** capture logs directly by identified container, serially, retaining sanitized partial events and fixed failure reasons/exit codes. Bound each capture by 30 seconds and 16 MiB. A separate inventory-plan command requires a matching completed manifest, dataset lock and read-only transactions; default estimate mode does not execute the audit, while explicit analyze keeps the existing tools deadline and preserves estimates on failure. This is diagnostic evidence, not dataset qualification. Ordinary benchmarks retain all preflight checks. The movement audit processes nonoverlapping ranges of at most 2,000 actual delivery UUIDs within one SQL snapshot, materializing bounded line/movement sets while preserving every existing quantity/phase/store check. Use existing indexes and unchanged resource/durability settings.

## 15. Agent operating rules

1. Read this specification before implementation; consult the PDF when source context or screen guidance is useful. Identify applicable requirements.
2. Do not add unrequested product features or infrastructure.
3. Allow selection of any application role during registration and enforce that role after registration.
4. Use exact pinned v4 APIs; inspect installed types rather than guessing from v3 examples.
5. Decode and validate external inputs at boundaries; encode outputs according to the API contract.
6. Keep domain decisions pure; permissions and writes must use current transactional state.
7. Parameterize SQL, allowlist dynamic sorts, and enforce DB constraints as well as application checks.
8. Do not substitute in-process mutexes for cross-connection DB concurrency protection.
9. Do not swallow expected failures, expose internal faults, or retry non-idempotent operations blindly.
10. Demonstrate relevant tests and report actual commands/results. Mark unrun checks explicitly.
11. Update contracts, migration files, tests and docs together when behavior changes.
12. Before submission, perform an independent correctness/security review and a fresh Compose startup rehearsal.

## 16. Documented assumptions and future changes

Resolved assumptions in this version: one company, Muscat business timezone, date-overlap filters, shortest graph distance, admin-only project edits/deletion, no implicit SuperAdmin membership-management override, scoped company-manager delivery projection, dependency changes only before dependent starts, soft deletion with restrictions, decimal quantities, zero-task completion 0%, session policy and delivery idempotency.

These defaults are settled for implementation, not a queue of questions requiring external clarification. Agents may resolve ordinary mechanical details themselves and document consequential choices. If Fabrizio changes a product decision, update this specification and affected contracts/tests together. Raise only substantive contradictions, missing decisions that materially affect correctness, or work that would expand scope.

After assignment completion, possible production changes include controlled privileged-role provisioning, more refined authorization, deployment-specific secrets/rate limiting, longer-term audit/idempotency retention, backup/restore procedures and workload-driven graph/read-model optimization. None is permission to expand the assignment now.

## 17. Final handoff checklist

- [ ] Source builds, type-checks and passes stated tests.
- [ ] Docker Compose starts from a fresh checkout with no manual setup.
- [ ] Full seed is runnable, counts verified and invariant checks recorded.
- [ ] Every screen in section 11 is supported by documented queries.
- [ ] Permission and concurrency acceptance cases pass against Postgres.
- [ ] API examples and OpenAPI match implemented behavior.
- [ ] README includes setup, versions, demo users, assumptions, architecture, tradeoffs, measured scale results and remaining limitations.
- [ ] Genuine commit history shows progression; no secrets or private product source copied into submission.
- [ ] Final independent review findings are resolved or explicitly disclosed.
- [ ] Repository link is prepared for Fabrizio to send to Sarvesh; do not send it without instruction.

## References

- Seron Labs: `SiteTrack-Backend-Assignment.pdf`, 6 November 2026 (8 pages); all assignment requirements must remain traceable to this source.
- Effect v4: https://effect.website/docs/v4/onboarding
- Effect API reference: https://effect.website/docs/v4/api
- Effect migration/versioning guidance: https://github.com/Effect-TS/effect/blob/main/MIGRATION.md
- PostgreSQL client: https://effect.website/docs/v4/api/sql-pg/PgClient
- SQL transactions: https://effect.website/docs/v4/api/effect/sql/SqlClient
- HTTP contracts: https://effect.website/docs/v4/api/effect/http-api/HttpApiBuilder

Keep this document in the eventual repository as `SPEC.md`. The final API/schema files refine it; they must not silently contradict it.
