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
This verifies the working-tree Docker workflow; the exact committed revision's
fresh-checkout/lifecycle rehearsal and final review remain pending.

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

This rehearsal is pending. Native integration tests, unit tests with a substituted
HTTP transport, and the earlier-stage Docker rehearsals do not replace it.

## Final delivery gates

Reconcile every required screen and error contract with OpenAPI and examples,
complete an independent correctness/security review, resolve or disclose findings,
and update the SPEC checklist only for demonstrated results. Include setup,
architecture, decisions, demo data, actual scale results and remaining limitations
in the handoff. Preparing the repository does not publish or send it anywhere.
