# Delivery verification

The delivery path is automated correctness checks, complete HTTP workflows,
a fresh-checkout Compose rehearsal, then final contract/security review.
Latency tuning, additional benchmarks, cloud comparisons and the optional
frontend are deferred. No private native credentials are needed for Docker.

## Current evidence

Fabrizio ran the targeted startup/migration/scale suite: 19/19 tests passed in
120.73 seconds. He then ran all PostgreSQL integration tests: 57/57 across nine
files passed in 358.43 seconds. `just check` passed formatting, zero-warning
lint, strict types, 92 unit tests and build before the workflow runner was added.
Logs are local and ignored: `.scale-results/phase1-integration.log`,
`.scale-results/phase2-integration.log`, `.scale-results/phase2-check.log`.

These results replace the older failed integration run as the current baseline;
the failed run remains documented in Stage 5. After the workflow runner was
added, `just check` passed again: 96 unit tests across fourteen files,
zero-warning lint, formatting, types and build. Four new tests exercise the
runner's target/transport/schema boundaries using a substituted HTTP transport.
They do not establish Docker HTTP workflow or fresh-checkout qualification.

Fabrizio then built and started the isolated Compose project
`sitetrack-review-20261116141237`: both services became healthy. Its real HTTP
workflow completed all 95 requests with expected statuses and schema/business
assertions, ended with `workflow_passed`, and revoked all created sessions.
No unexpected 5xx response or workflow failure was recorded. Local logs are
`.scale-results/phase3-compose.log` and `.scale-results/phase3-workflows.log`.
This verifies the working-tree Docker workflow. The exact-commit rehearsal and
final review below are also complete. Final documentation was committed in
`6567d277`; README, authorship and license cleanup followed in `fa4413b67`.
Repository sharing remains for the owner.

The source security review completed for all 61 files under `src/` at
`45d57f351`, using an independent baseline auditor, independent architecture
mapping, a focused inventory investigator and parent source verification. No
reportable vulnerability was established. Root deployment/configuration, docs
and tests supported the review; dependency internals, vendored code, private
secrets and production infrastructure were excluded. This was a static source
review, not an external penetration test or guarantee of vulnerability absence.
The sealed local Codex Security scan is
`9cf1d500-898e-40d6-9a75-1f19b48b16a3`; its canonical report remains outside Git.

The API contract review reconciled auth/session guidance, schemas and the nine
feature screen areas in SPEC section 11 with the handlers and tests. A read-only
inspection of the running generated OpenAPI matched the compiled contracts for
all 50 required feature operations and their success/authentication/error statuses,
including DELETE operations returning 204. The Stage 2 guide was corrected to describe the
implemented task summaries and project filters. No application code changed in
this final review; the tested application revision remains `45d57f351`.

## Run the HTTP workflows

Run longer commands personally from the repository root. Use the optional Nix
shell for npm/Just. The Docker daemon is the local Unix socket, and Compose
explicitly skips private environment files. Start a new reviewer project using
an unused loopback port (3003 below; change it if occupied):

```sh
nix develop
mkdir -p .scale-results
set -o pipefail
export SITETRACK_REVIEW_PROJECT="sitetrack-review-$(date +%Y%m%d%H%M%S)"
export SITETRACK_HTTP_PORT=3003

review_compose() {
  docker --host unix:///var/run/docker.sock compose --env-file /dev/null \
    -f compose.yaml --project-name "$SITETRACK_REVIEW_PROJECT" "$@"
}
```

Before first startup, both commands below must print nothing. If either lists
resources, choose another new project name; do not reset or delete those resources.

```sh
docker --host unix:///var/run/docker.sock ps -aq \
  --filter "label=com.docker.compose.project=$SITETRACK_REVIEW_PROJECT"
docker --host unix:///var/run/docker.sock volume ls -q \
  --filter "label=com.docker.compose.project=$SITETRACK_REVIEW_PROJECT"
```

Build/start, then exercise the API:

```sh
review_compose up --build --detach --wait --wait-timeout 240 \
  2>&1 | tee .scale-results/phase3-compose.log
just verify-workflows "$SITETRACK_REVIEW_PROJECT" \
  2>&1 | tee .scale-results/phase3-workflows.log
```

Only run the second command after startup succeeds. The equivalent npm command
is `npm run verify:workflows -- "$SITETRACK_REVIEW_PROJECT"`. The host command
requires a `sitetrack-review-*` project name and runs the compiled check inside
that project's API container. The check requires explicit demo-write permission,
the public Compose database configuration and internal port 3000. It always
contacts container-local HTTP, refuses redirects, and reads no private bundles.

The workflow creates four uniquely named demo users, another login session,
one project, three tasks, one material and four deliveries. It performs no
database reset or large seed. All nine screen areas are exercised, including:

- Registration, login, refresh rotation/replay rejection, logout and independent sessions.
- Invitations, recipient-only notifications, membership/admin controls and immediate access revocation.
- Task dependencies, shortest distances, illegal cycles/starts/reopens, completion and project summaries.
- Catalogue search, exact stock quantities, delivery receipt/return/cancel/reject, idempotent retries and immutable history.
- Scoped list items/totals, pagination, filters, expected 400/401/403/404/409 responses, OpenAPI/docs and browser CORS.

Responses are decoded against application schemas and business assertions. Each
request has a twelve-second allowance; the whole runner has a three-minute
budget. Progress contains only fixed check labels, HTTP status and request IDs.
Success ends with `workflow_passed`; failure exits nonzero with `workflow_failed`.
Passwords, tokens, cookies and response bodies are never written to reports.

Successful completion revokes the created sessions. On failure, partial demo
data/sessions may remain in this isolated environment; preserve the failure log.
Reruns create new demo records rather than deleting previous data. Registration
is rate limited: allow at least a minute before rerunning against the same API.
The demo records and their history remain in the reviewer volume.

After inspection, stop only this reviewer project and retain its volume:

```sh
review_compose down
```

## Fresh-checkout rehearsal

After the reviewed changes have been committed, use a separate clean checkout of
that exact commit, without copying `.env`, SOPS bundles, `node_modules` or build
output. Name its checkout directory `sitetrack-review-<unique-suffix>` so Compose's
default project name also satisfies the workflow guard. Clear local `COMPOSE_*`
and `SITETRACK_HTTP_PORT` overrides. Startup qualification must use plain
`docker compose up` there, with
port 3000 available and no local Compose overrides. It must build and serve
`/health/live`, `/health/ready`, `/openapi.json` and `/docs` without Nix/Just/npm
or manual migrations. Record the commit and image identifiers.

Run the HTTP workflow command against its explicitly named reviewer project,
then verify API shutdown exits zero, readiness fails within its bounded allowance
while the database is stopped, liveness remains available, and readiness recovers
after PostgreSQL returns. Record persistence and monotone IDs across API and full
Compose restarts; `down` must retain the volume. Confirm the API runs as a non-root
user, PostgreSQL has no published port, all seven migrations are applied once,
durability is enabled and logs contain no issued credentials.

The owner completed this rehearsal from a clean local clone at
`45d57f3516957c994a3d9d9576d7f09a2268e199`, project
`sitetrack-review-20261116142545`, using plain `docker compose up` without copied
secrets/dependencies/build output or manual migrations. API image:
`sha256:209e712aea435fba46f7e149cf71f9c0e78eccfbc1f1a5d113c285cee521c9ab`.

| Check | Observed result |
| --- | --- |
| Clean-checkout HTTP workflows | All 95 requests and schema/business assertions passed |
| Graceful API stop | Exit 0; stop command took about one second |
| Database outage | Readiness 503 in 2.004184s with generic error; liveness 200 |
| Database recovery | Readiness recovered; API container ID and start timestamp unchanged |
| API/database/full Compose restarts | Project/task/inventory/ledger/sequence snapshots matched before further writes |
| Volume and image | Named volume retained across down/up; API image unchanged |
| Post-restart HTTP workflows | All 95 requests passed; next project was PRJ-0002; sessions revoked |
| Deployment checks | Non-root API, no PostgreSQL host port, seven migrations and normal durability |

Local evidence is under `.scale-results/phase4/`: `compose.log`, `workflows.log`,
`lifecycle.log`, `restart-workflows.log`, snapshots and bounded health responses.
The first lifecycle helper run failed before restarts because its snapshot used
the API projection name `received_at` as a SQL column. The local helper was
corrected to stored `initiated_at`/`closed_at`, validated using read-only EXPLAIN,
and rerun successfully. The earlier error log is retained. No application schema
or data repair was necessary. Raw evidence and the helper remain local/ignored.

This is a fresh-checkout rehearsal on the owner's existing Docker host, not a
claim of testing a different operating system or a cloud server.

## Final delivery gates

The source tests, permission/concurrency acceptance cases, clean-checkout startup,
HTTP workflows, lifecycle checks and final scoped source review have passing
evidence. Required setup, API, seed, architecture, decisions, measured results and
limitations are documented. No unresolved correctness/security finding was
established by this review. Final full mixed-workload performance qualification
is deferred, with earlier errors and missed tuning targets disclosed in Stage 5.

The final documentation and README/authorship/license cleanup are committed
through `fa4413b67`. The owner still needs to commit this scan-result update,
prepare repository visibility/access and send its link. No commit, push,
publication or message is performed by this review. Future changes to application
code require verification appropriate to those changes; application evidence
remains tied to `45d57f351`.

TruffleHog 3.95.5 completed against committed history at `fa4413b67`, separately
from the scoped source audit. Live credential verification and update checks were
disabled. The scanner exited 183 for 23 candidates; redaction and report writing
both exited zero, with no malformed output lines. Static triage classified four
matches as public Compose demonstration credentials, two as deliberately invalid
configuration-test URLs, and seventeen as upstream Effect tests, examples and
benchmark references. None of the reviewed candidates established a private
credential leak; this is not a zero-finding scanner result.

The scan used a temporary bare Git copy and retained only sanitized
detector/location metadata under ignored `.scale-results/trufflehog/`.
Untracked private SOPS files were outside the scan. The `repos/**` exclusion
filtered current vendored paths, but original paths in the imported Effect
subtree history were still scanned, explaining the seventeen upstream matches.
