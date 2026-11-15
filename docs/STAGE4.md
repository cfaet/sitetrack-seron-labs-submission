# Stage 4: materials, stock and deliveries

Stage 4 completes the catalogue and company/project inventory workflow. It uses
the same Effect 4.1.2 services, PostgreSQL configuration, authentication and
migration runner as Stages 1–3. No extra package, private secret or host service
is required. Full-company seeds and resource-budget benchmarks remain Stage 5.

## Quantities and catalogue

All quantities cross HTTP and database decoding boundaries as decimal strings,
never JSON numbers. Inputs allow 1–14 integral digits and optionally 1–6 fractional
digits. Leading zeros are accepted within that length limit. Signs, exponents,
whitespace, non-finite values and excess precision are rejected with 400.
Responses remove redundant leading/trailing zeros: `"0001.250000"` becomes
`"1.25"`, and zero is `"0"`. Stock additions and delivery lines must be positive;
reorder points may be zero.

Pure arithmetic uses bigint millionths, without floating-point conversion or
rounding. Stored quantities use PostgreSQL `numeric(20,6)`, with a maximum of
`"99999999999999.999999"`. Aggregate transit quantities can exceed that bound and
still return exact plain strings. Numeric values are cast to text before being
placed into database JSON projections.

Materials have immutable UUIDs, a trimmed name (1–200 UTF-16 code units), category
(1–100), and unit (1–40). Category/unit values are free text and names need not be
unique. All authenticated roles can read and manage the shared catalogue. Units
may change only before any balance row or delivery/movement history exists;
setting a reorder point also creates a balance row. Name/category edits remain
available, while delivery-line material names and units retain their original
snapshots.

Material deletion is soft and requires no positive stock anywhere and no
in-transit deliveries. Deleted catalogue items disappear from normal stock and
catalogue reads. Historical delivery snapshots remain readable by authorized
actors. Project deletion similarly rejects positive project stock or any
in-transit delivery, then follows the existing soft-deletion/invitation policy.

## HTTP contracts

Paths below are relative to `/api/v1`. Use Bearer authentication. Writes with JSON
require `Content-Type: application/json`; the auth-only CSRF header is not needed
for inventory commands. Browser CORS allows `PUT` and `Idempotency-Key`.

| Method/path | Input | Result |
| --- | --- | --- |
| GET `/materials` | page/pageSize, search, category | Paginated active materials, name then immutable ID |
| POST `/materials` | `{ name, category, unit }` | 201 material |
| GET `/materials/{materialId}` | — | Material |
| PATCH `/materials/{materialId}` | Nonempty subset of name/category/unit | Updated material |
| DELETE `/materials/{materialId}` | — | 204, subject to reference guards |
| GET `/company-store/stock` | Stock query | Paginated company stock |
| POST `/company-store/stock/additions` | `{ materialId, quantity }` | 201 `{ id, materialId, quantity, createdAt }` addition receipt |
| PUT `/company-store/stock/{materialId}/reorder-point` | `{ reorderPoint }` | Updated company-stock row |
| GET `/projects/{projectId}/store` | Project-stock query | Paginated project stock |
| GET `/company-store/deliveries` | Delivery query plus optional projectId | Paginated company deliveries |
| POST `/company-store/deliveries` | `{ projectId, lines }` | 201 CompanyToProject delivery |
| GET `/projects/{projectId}/deliveries` | Delivery query | Paginated deliveries for that project |
| POST `/projects/{projectId}/deliveries` | `{ lines }` | 201 ProjectToCompany delivery |
| GET `/deliveries/{id}` | — | Visible delivery detail |
| POST `/deliveries/{id}/record` | `{}` | Delivered detail |
| POST `/deliveries/{id}/reject` | `{}` | Rejected detail |
| POST `/deliveries/{id}/cancel` | `{}` | Cancelled detail |

Every delivery contains 1–100 distinct `{ materialId, quantity }` lines. Duplicate
UUIDs, including different casing of the same UUID, are rejected before writing.
UUID casing and quantity formatting are normalized for idempotency.

Materials return `{ id, name, category, unit }`. Stock rows include that material
object and `quantity`. Project rows add `lastDeliveryAt`; company rows add
`inTransitQuantity`, `reorderPoint` and `status`. A company page includes every
active material, using zero when a balance/reorder point is absent. A project
page includes only its existing balance rows, including historical zeros.

Company stock queries accept search, category, status, sort (`name`, `quantity`,
`status`) and direction (`asc`, `desc`). Project stock accepts search, category,
sort (`name`, `quantity`, `lastDelivery`) and direction. Searches match names
case-insensitively; category filters use case-insensitive exact matches. Sort
defaults to name ascending, with immutable tie-breakers and missing delivery
timestamps last. Stock status order is OutOfStock, LowStock, Available. Zero
always means OutOfStock; positive quantity at/below reorder means LowStock.

Delivery queries accept direction (`CompanyToProject`, `ProjectToCompany`), status
(`InTransit`, `Delivered`, `Rejected`, `Cancelled`), fromDate and toDate, with the
standard page/pageSize. Company queries also accept projectId. Dates filter
inclusive UTC initiation dates, independent of the company business timezone.
Default ordering is initiation time descending then immutable ID descending.

Delivery detail and list items include `id`, minimal `project` (ID/name), direction,
status, immutable `lines`, `initiatedAt`/`initiatedBy`, `receivedAt`/`receivedBy`,
`closedAt`/`closedBy`, and advisory `allowedActions`. People are projected as
ID/name, without email, role or membership data. Receipt metadata exists only for
Delivered; closure metadata covers every terminal state. Lines use
`{ material: { id, name, unit }, quantity }`, ordered by material ID.

All lists retain the existing pagination envelope, 25-row default and 100-row
maximum. Unknown query/body fields fail. Counts, filters, ordering, transit sums
and returned items use consistent access scope and database snapshots. Delivery
pages select parents before loading their bounded lines; no company-wide line
expansion is returned.

## Permissions and transaction behavior

CompanyStoreManager and SuperAdmin can inspect company inventory, add stock, set
reorder points and send deliveries to existing projects. That operation does not
grant general project lookup, task or membership access. Company delivery views
expose only the minimal project/delivery projection.

Current project members and SuperAdmins can inspect project stock/deliveries and
send stock back to the company. Destination authority permits record/reject;
source authority permits cancel, regardless of which individual initiated it.
For CompanyToProject, a project member receives and a company manager cancels.
For ProjectToCompany, a company manager receives and a project member cancels.
SuperAdmin has both store-side authorities. A visible but forbidden action is
403; hidden project/delivery resources are 404. Current roles and memberships are
rechecked after relevant waits, including before returning an idempotent replay.

Every inventory mutation has one transaction/connection. Acquisition order is:

1. Session authorization lock.
2. Optional transaction-scoped idempotency advisory lock.
3. Material rows in immutable ID order (shared for stock operations, exclusive
   for catalogue mutations).
4. Applicable project row, then delivery row for terminal actions.
5. Stock rows in deterministic store/material order, creating absent rows safely.

Inventory orchestration does not acquire material locks through the project-only
transaction helper. Project deletion/membership operations use the same project
row coordination. Material unit/deletion guards run after their exclusive lock.
No process-local mutex replaces these database locks.

Initiation subtracts every source quantity, creates an InTransit delivery and
snapshots, and appends dispatch movements. Record credits the destination;
reject/cancel refund the source. Each terminal command creates one positive
terminal movement per line. All balances, movements, delivery status and retry
outcomes commit or roll back together. The losing terminal action returns 409.

Overflow returns `409 QUANTITY_OVERFLOW`; failed receipts/refunds leave the
delivery InTransit and all quantities/movements unchanged. There is no capacity
reservation. Move stock before retrying the affected action. Insufficient source
stock returns `INSUFFICIENT_STOCK`. Other conflicts include
`DELIVERY_STATE_CONFLICT`, `MATERIAL_UNIT_LOCKED`, `MATERIAL_IN_USE`,
`PROJECT_NOT_EMPTY` and `IDEMPOTENCY_CONFLICT`. The existing generic error envelope
and request IDs apply.

`lastDeliveryAt` advances only for committed delivery activity affecting that
store: initiation, receipt or refund. Failed commands and replays do not advance
it. Company transit totals count only InTransit CompanyToProject lines. Per
material, all store balances plus all in-transit lines must equal supplier
additions; each balance must equal its signed movement sum. There are no stock
adjustment, consumption or project-to-project transfer endpoints.

Migration 0006 supplies foreign keys, finite/range/positive checks, unique
balances and lines, coherent terminal metadata, and unique dispatch/terminal
movement phases. Authorization, permitted transitions, reference-sensitive
deletion and immutable public delivery lines are enforced by application
transactions. Direct SQL is not an alternative business mutation API.

## Idempotent retries

An optional `Idempotency-Key` applies to stock additions, delivery initiation and
record/reject/cancel. Keys contain 1–128 letters, digits or `._:-`. Invalid keys
return 400. Scope is current user plus operation kind plus key, across sessions
and restarts; keep the same key when retrying a command whose outcome is unknown.

Fingerprints include target IDs, direction and normalized input. Quantities with
equivalent formatting and reordered distinct material lines are equivalent.
Matching retries reauthorize and return the original saved success status/body
without changing stock. The response is an operation snapshot: GET delivery
detail for current state. Different normalized input under the same key returns
409. Failed transactions leave no successful key record. Records do not expire
in this assignment.

Without a key, additions and initiations execute independently. Terminal state
guards still apply, so another terminal action returns 409. Reorder-point PUT is
an absolute assignment and creates no stock movement. Successful request IDs are
fresh per HTTP request even when the operation body is replayed.

## Curl workflow

Create one normal project user and one CompanyStoreManager using the
[Stage 2 client workflow](STAGE2.md#curl-walkthrough). Keep their current Bearer
headers in separate private files, referenced below as `$owner_headers` and
`$manager_headers`. No private token belongs in shell output or committed files.
Replace IDs with values from your own responses:

```sh
curl --fail-with-body --silent --show-error \
  -H "@$owner_headers" -H 'Content-Type: application/json' \
  -d '{"name":"Cement","category":"Masonry","unit":"kg"}' \
  http://localhost:3000/api/v1/materials

curl --fail-with-body --silent --show-error \
  -H "@$manager_headers" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: supplier-arrival-001' \
  -d '{"materialId":"REPLACE_MATERIAL_UUID","quantity":"100.25"}' \
  http://localhost:3000/api/v1/company-store/stock/additions

curl --fail-with-body --silent --show-error \
  -H "@$manager_headers" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: dispatch-001' \
  -d '{"projectId":"REPLACE_PROJECT_ID","lines":[{"materialId":"REPLACE_MATERIAL_UUID","quantity":"10.25"}]}' \
  http://localhost:3000/api/v1/company-store/deliveries

curl --fail-with-body --silent --show-error \
  -H "@$owner_headers" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: receipt-001' -d '{}' \
  http://localhost:3000/api/v1/deliveries/REPLACE_DELIVERY_UUID/record
```

To return material, POST `{ "lines": [...] }` as a project member to
`/projects/{projectId}/deliveries`, then record it as a company manager. Refresh
each session according to Stage 2 and remove private temporary files afterward.

## Verification

Verified on 15 November 2026:

| Check | Result |
| --- | --- |
| `nix develop --command just check` | Formatting, Effect-aware lint, strict types, 68 unit tests and production build passed; zero lint errors or warnings |
| Full PostgreSQL suite | All 47 integration tests passed across seven files against PostgreSQL 16.16 in 195.08 seconds; `fsync`, `synchronous_commit` and `full_page_writes` explicitly on, unchanged deadlines |
| Exact quantities | Fractional arithmetic, minimum/maximum quantities, overflow, canonical formatting and 300 generated round trips passed; transit aggregates beyond a single balance's range remained exact |
| Inventory correctness | Both directions, record/reject/cancel, atomic multi-line failure, movement reconciliation and conservation passed |
| Concurrency | Separate connections deliberately overlapped absent-row creation, company withdrawals across different projects, terminal races, matching/conflicting retry keys, material deletion/unit changes, project deletion and membership/role changes |
| Replay | Normalized decimals and line order, different target IDs, separate sessions/users, failed-key reuse, current authorization and duplicate terminal requests verified |
| Access and screens | Company/project restrictions, empty-page metadata, search/filter/sorts, inclusive UTC date ranges and manager projections without task/member/email fields passed |
| Database guards | Negative/non-finite balances, non-finite reorder points, invalid lines, incoherent terminal metadata and duplicate/missing movement phases rejected |
| Retained schema | Stage 1/2/3 upgrade and reapplication passed; Stage 3 task IDs, counters, membership and stores survived; migrations 0001–0005 unchanged |
| Fresh Compose | Empty isolated volume started API/database with six automatic migrations, normal durability and a non-root API; no private bundle, manual migration or extra package required |
| Curl and generated docs | 48 HTTP checks passed, plus comparison of Swagger's embedded contract with `/openapi.json`; the optional retry header and PUT preflight were exercised |
| Persistence | API restart and full Compose down/up retained sessions, quantities, delivery state, six-entry migration ledger and saved idempotent outcomes; movement sums still matched balances |
| Cleanup | Private curl files removed; disposable schemas cleaned and PostgreSQL servers stopped; rehearsal containers/network removed, volume retained |

An earlier expanded PostgreSQL pass had 14 successes and two fixture-setup
failures: a five-second timeout while creating `users` and the startup deadline
during an index creation. Both affected cases passed in isolation with unchanged
settings, and the final full suite passed without statement timeouts. The
underlying intermittent host/setup contention was not conclusively diagnosed;
durability was not disabled to obtain these results.

The first curl rehearsal passed its initial 39 checks but its restart probe used
the old randomly allocated host port. Container health was good; Docker had
assigned a different port on restart. Refreshing the binding corrected the
temporary harness, and the full 48-check flow then passed without an application
change. The isolated rehearsal retained its data throughout.

Verified image ID:
`sha256:1c9797963d3bdde429881af3cf77390589003a2d35d9c533223920ff8fcd9080`.
The retained rehearsal volume is
`sitetrack-stage4-3d4724f1_postgres_data`. Earlier stage volumes and native
development data were not reset or removed. The rehearsal used unused loopback
ports and a local Docker socket.

These results cover STOCK-01/02, DEL-01/02/03, DELETE-01, ACL-01/02/03 and the
affected BOOT/DOC contracts. This stage did not perform a full-company seed,
resource-budget latency qualification, independent security audit or
crash/power-loss recovery test. Those results are not implied by functional
tests, migration/restart success or an enabled durability setting.
