# Stage 2: identity and project access

The API implements registration/login/refresh/logout, profile reads, projects,
memberships, invitations and recipient-scoped notifications. Task statistics and
graphs are Stage 3; stock, delivery behavior and company-store projections are
Stage 4. There is no frontend or large seed yet. This guide records the Stage 2
checkpoint; [Stage 3](STAGE3.md) adds task/graph routes and project task summaries.

## Runtime and configuration

Effect packages and the read-only reference remain 4.1.2. Password hashing uses
`effect/crypto/Kdf` through `NodeCrypto.layerKdf`; JWTs use `effect/jose/Jwt` with
`NodeCrypto.layerMac`. Both were checked against installed types and exercised
on Node 24.22.2; Docker pins Node 24.22.3. No dependencies or lockfiles changed.

| Variable | Behavior |
| --- | --- |
| `AUTH_JWT_SECRET` | Required canonical base64url encoding of at least 32 random bytes; redacted in configuration |
| `AUTH_COOKIE_SECURE` | `true` by default; explicitly set `false` for local HTTP |
| `AUTH_ALLOWED_ORIGINS` | Comma-separated exact origins; default `http://localhost:3000,http://127.0.0.1:3000`; no wildcards, paths or `null` |

The native server needs a persistent private signing key in the owner-managed
`secrets/dev.enc.env` bundle. Edit it with SOPS and add `AUTH_JWT_SECRET` and,
for local HTTP, `AUTH_COOKIE_SECURE=false`. Do not send the key through chat.
Database CLI commands do not need authentication configuration. Integration tests
inject synthetic signing material and still require only the separate explicit
disposable test database configuration. No private bundle is needed by Compose:
it uses a clearly marked public demo signing key and HTTP cookie setting.

## Session and client contract

SiteTrack can be used by any client that implements HTTP: browsers, HTTP
libraries, mobile apps, backend services, curl and API testing tools. A browser
is not required. Every client follows the same JSON, Bearer-token, refresh-cookie
and authentication-header contract. The API overview, security schemes and auth
operation descriptions in `/openapi.json` explain this workflow directly in
Swagger as well as in this guide.

Registration and login create separate sessions. Their JSON responses, and
refresh responses, contain `user`, `accessToken`, `tokenType=Bearer`,
`accessTokenExpiresAt`, `refreshExpiresAt` and `sessionExpiresAt` (absolute).
There is no refresh token in JSON. Responses from `/api/v1/auth/*` and `/api/v1/me`,
including failures, use `Cache-Control: no-store`.

Access JWTs last 15 minutes. Verification fixes HS256, issuer `sitetrack`,
audience `sitetrack-api`, `typ=at+jwt`, access-token purpose, user/session IDs,
issued time, expiry and token ID. JWT input is bounded to 8 KiB. Current user role
and live session state come from PostgreSQL on every request; role claims are
not cached in tokens. Idle and absolute expiry must decode to finite epoch
milliseconds. Non-finite stored deadlines are invalid database data: access and
refresh return the generic 500 error without issuing a cookie or rotating the
refresh credential. Ordinary expired/revoked sessions return 401.

Refresh credentials contain a session UUID and 32 random bytes. Only their
SHA-256 hash is retained. The cookie is host-only `sitetrack_refresh`, `HttpOnly`,
`SameSite=Lax`, path `/api/v1/auth`, with `Secure` controlled as above. Its lifetime
is at most seven days and cannot exceed the session's thirty-day absolute limit.
Refresh rotates the credential under a session lock and extends the seven-day
idle deadline within that absolute bound. Old/replayed credentials return 401;
they do not revoke the winning rotation or clear its cookie.

Logout requires the Bearer access token, revokes that token's session and expires
the refresh cookie with the same path/attributes. Other sessions survive. The
frontend should refresh an expired access token before authenticated operations,
including logout; a revoked/expired refresh session requires a new login.

For browser clients:

1. Hold the access token in memory; send it as `Authorization: Bearer ...`.
2. Use `credentials: "include"` for registration/login/refresh/logout. On reload,
   refresh first to obtain an access token from the existing HttpOnly cookie.
3. Send JSON and `X-CSRF-Protection: 1` on **every auth POST**. Refresh/logout use
   `{}` bodies. The custom header is also required for curl.
4. Every supplied `Origin` on auth POSTs must match the allowlist. Configure a
   frontend origin explicitly, e.g. `http://localhost:5173`, before cross-origin
   browser development. Allowed preflights include credentials, Authorization,
   Content-Type and X-CSRF-Protection; responses expose X-Request-Id/Retry-After.
5. The initial cookie policy supports same-site frontend/API deployments.
   Unrelated cross-site domains and a reverse-proxy trust policy are not supplied.

### Non-browser clients

Enable the HTTP library's cookie jar; some libraries do not enable cookie
persistence by default. Let it process `Set-Cookie` from registration, login,
refresh and logout, respecting the cookie's host, path, expiry and Secure flag.
Send the applicable `Cookie` header when refreshing. A client without a cookie
jar can implement this explicitly: retain cookie name/value pairs and their
attributes, then send only applicable name/value pairs in `Cookie`, not the
entire `Set-Cookie` response value. Curl's `-c` saves cookies and `-b` sends them;
use both when refresh rotates the credential.

Retain the access token separately and send it as a Bearer token on protected
requests, including logout. Mobile apps should use platform-provided secure
storage for credentials that must survive process restarts. Backend/library
clients should keep credentials private and avoid logging authentication bodies,
Cookie, Set-Cookie or Authorization headers. HttpOnly restricts browser
JavaScript; it does not prevent a native client or HTTP library from handling
the refresh cookie.

All auth POSTs still require JSON and `X-CSRF-Protection: 1`; refresh/logout use
`{}` bodies. The literal header value is not a secret. CORS is a browser policy,
but the server's auth Origin check applies whenever a client supplies that
header. Non-browser clients normally omit Origin; if they send it, it must match
the configured allowlist. They do not need browser `credentials: "include"`
syntax; their cookie jar or explicit Cookie header performs that work.

When a protected operation returns 401 because the access token expired, refresh
once and retry it with the new token. Serialize refresh attempts and store the
new cookie before the next one; a rotated credential cannot be reused. If refresh
returns 401, log in again. Logout requires a valid Bearer token, revokes only that
session, and expires its cookie. Process that response and discard the local
access token. The curl walkthrough below exercises this complete sequence.

See [MDN cookie semantics](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)
and [OWASP custom-header CSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html#employing-custom-request-headers-for-ajaxapi).
Cookie-only requests do not authorize ordinary API reads/writes.

## Inputs, responses and endpoints

Email is trimmed and lowercased; display/project names are trimmed. Passwords
are preserved exactly and accept 15–128 Unicode code points. Display names are
1–120 UTF-16 code units; project names 1–200; email at most 254. Dates are actual
Gregorian `YYYY-MM-DD` values, with start on/before end, including after partial
updates. Reject unknown fields and cap JSON bodies at 16 KiB.

Successful creates return 201, other reads/commands 200, deletes/logout 204.
Expected failures use `{ code, message, requestId }`: 400 input, 401 authentication,
403 visible-but-forbidden, 404 missing/hidden, 409 state/uniqueness, 413 oversized
body, 429 throttling, 503 retryable database unavailability. Unexpected failures
return a generic 500. Passwords, refresh credentials, signing keys, SQL and raw
validation inputs are not part of public errors/logs.

All following paths are relative to `/api/v1`; generated `/openapi.json` is the
executable contract, including Bearer and refresh-cookie schemes and auth response
headers. Bundled Swagger stays at `/docs`.

| Group | Endpoints |
| --- | --- |
| Accounts | POST `/auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`; GET `/me` |
| Projects | GET/POST `/projects`; GET/PATCH/DELETE `/projects/{projectId}` |
| Members | GET `/projects/{projectId}/members`; PATCH/DELETE `/projects/{projectId}/members/{userId}` |
| Invitations | GET/POST `/projects/{projectId}/invitations`; POST `/projects/{projectId}/invitations/{id}/withdraw`; POST `/invitations/{id}/accept`, `/reject` |
| Notifications | GET `/notifications`, `/notifications/unread-count`; POST `/notifications/{id}/read` |

Collections return `{items,pagination:{page,pageSize,total,totalPages}}`.
Defaults are page 1 and size 25, maximum size 100 and maximum page 1,000,000.
Projects support `search`, `hasLate=true|false`,
`sort=name|startDate|completionPercentage|lateCount` and `direction=asc|desc`;
notifications/invitations are newest first; members sort by name. Immutable IDs
break ties. Rows and totals share a SQL snapshot and the same access scope,
including empty/out-of-range pages. Project invitation lists show pending items.

Projects expose `id`, `name`, `startDate`, `endDate`, caller `isAdmin` and
`memberCount`, plus the implemented Stage 3 `taskCounts`, `completionPercentage`,
`lateCount` and `blockedCount`. IDs use the retained global sequence, including
`PRJ-10000` and beyond. See [Stage 3](STAGE3.md#http-contracts) for the summary
semantics and derived filters/sorts; these fields are real current projections.

Invitation commands return an invitation with `Pending`, `Accepted`, `Rejected`
or `Withdrawn` status and user/project identifiers. Member PATCH accepts only
`{isAdmin:boolean}`; project PATCH only name/dates. Notification summaries contain
only the invitation/project information needed to answer; `allowedActions` is
empty after terminal states. Reading is idempotent. Answering marks read;
withdrawal does not mark read.

## Persistence, authorization and races

New migrations 0002–0004 add users/sessions, projects/memberships/minimal stores,
and invitations/notifications. Migration 0001 and its sequence are unchanged.
Project creation writes its first admin and empty project store atomically; a
migration provisions one empty company store. Stock/delivery tables arrive later.

Repositories parameterize SQL and decode result rows. Application services own
transactions; pure schemas/date/ID rules have no I/O. HttpApi handlers decode
inputs and encode declared outputs; session cookies are added after the service
transaction has committed. Middleware overwrites incoming request IDs with a
server-generated value for both authentication errors and ordinary handlers.

Write lock order is session, project, then invitation. Session revocation/rotation
use a session-row update lock. Project writes take a session share lock and a
project update lock, then recheck current role/membership. Project locking also
serializes final-admin changes, invitation creation/answers and project deletion.
The last-admin invariant is application-enforced through this shared lock; the
partial unique pending-invitation index is a database backstop.

SuperAdmin sees all projects but needs admin membership to edit/delete or manage
members/invitations. Other users, including CompanyStoreManager, see only member
projects. Outsiders get the same 404 for missing and existing project resources.
Recipients may see their own minimal invitation notification without membership.
Acceptance adds a non-admin member atomically; withdrawal/answer races have one
winner. Soft deletion hides the project and withdraws its pending invitations,
retaining membership/store/notification history. Later inventory deletion guards
will be added when stock and delivery tables exist.

Passwords use Argon2id with 65,536 KiB memory, three passes, one lane, a random
16-byte salt and 32-byte result. Stored JSON has an explicit `argon2id-v1`
identifier; comparison is constant time. Unknown-account logins perform dummy
password derivation. See the installed Kdf/NodeCrypto source and
[OWASP password storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).

There are two active password derivations and at most eight waiting. Global auth
admission precedes per-peer-IP keys, bounding live in-memory limiter state. Login
limits: 120/minute globally, 20/five minutes per IP. Registration: 30/minute globally,
five/minute per IP. Forwarded IP headers are ignored. Limits return 429 and
Retry-After, reset on process restart and are not shared across instances.

## Curl walkthrough

Start `docker compose up`, then use the public local demo values below. Auth
responses and the cookie jar are saved privately instead of printing credentials:

```sh
umask 077
stage2_curl_dir="$(mktemp -d)"
curl --fail-with-body --silent --show-error \
  -H 'Content-Type: application/json' -H 'X-CSRF-Protection: 1' \
  -c "$stage2_curl_dir/cookies" -o "$stage2_curl_dir/session.json" \
  -d '{"name":"Demo User","email":"demo@example.test","password":"Local demo password only!","role":"User"}' \
  http://localhost:3000/api/v1/auth/register

# Build a private curl header file using the Node runtime already in the API image.
docker compose exec -T api node -e \
  'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write("Authorization: Bearer "+JSON.parse(s).accessToken+"\n"))' \
  < "$stage2_curl_dir/session.json" > "$stage2_curl_dir/headers"
curl --fail-with-body --silent --show-error \
  -H "@$stage2_curl_dir/headers" http://localhost:3000/api/v1/me
curl --fail-with-body --silent --show-error \
  -H "@$stage2_curl_dir/headers" -H 'Content-Type: application/json' \
  -d '{"name":"Example Site","startDate":"2026-01-01","endDate":"2026-12-31"}' \
  http://localhost:3000/api/v1/projects

curl --fail-with-body --silent --show-error \
  -H 'Content-Type: application/json' -H 'X-CSRF-Protection: 1' \
  -b "$stage2_curl_dir/cookies" -c "$stage2_curl_dir/cookies" \
  -o "$stage2_curl_dir/session.json" -d '{}' \
  http://localhost:3000/api/v1/auth/refresh
# Rebuild the headers file with the command above after refreshing.
curl --fail-with-body --silent --show-error \
  -H "@$stage2_curl_dir/headers" -H 'Content-Type: application/json' \
  -H 'X-CSRF-Protection: 1' -b "$stage2_curl_dir/cookies" \
  -c "$stage2_curl_dir/cookies" -d '{}' \
  http://localhost:3000/api/v1/auth/logout
```

For an existing account, use `/auth/login` with email/password instead of repeating
registration. Keep the temporary credential files private and remove them after
use. No demo user is automatically seeded.

## Verification

Verified on 14 November 2026:

| Check | Result |
| --- | --- |
| `nix develop --command just check` | Type-checking, 40 unit tests and production build passed |
| `npm run test:integration` inside Nix | 25 tests passed against fresh isolated PostgreSQL 16.16 under `/tmp`, including the nine foundation tests plus the Stage 1 upgrade case and Stage 2 HTTP/races |
| Additional ACL checks | Seven project/team cases rerun successfully after adding current-role authorization and recipient-metadata assertions |
| Test cleanup | Zero generated schemas remained after each PostgreSQL run; temporary servers stopped |
| Race evidence | Separate connections held behind real database locks until both contenders were observed waiting; registration, rotation/logout, invitation decision and final-admin races passed |
| Fresh Compose | Project `sitetrack-stage2-20261114-3ecd7f` built and became healthy with an initially empty volume, without manual migrations, SOPS or an environment-file copy |
| Authenticated Docker flow | Registration, seven-day cookie, hidden-project 404, invitations/notifications, acceptance, refresh rotation/replay, and logout/session isolation passed |
| OpenAPI/docs | Cookie and Bearer schemes, Set-Cookie headers, registration 201 and logout 204 match runtime; bundled Swagger passed |
| Database outage | Liveness stayed 200; readiness returned 503 in 2,005 ms and recovered with the same API container |
| Shutdown/restart | API exited 0 in 1,252 ms; accounts, sessions, memberships and project IDs persisted; sequence continued 2 to 3 and ledger stayed at four migrations |
| Real curl cookie jar | Documented registration/profile/project/refresh/logout flow passed, with 401 after logout; temporary credential files removed |
| Packaging/logs | API user is `node`, database has no published host port, sampled logs omitted test credentials and connection strings |
| Cleanup | Rehearsal containers/networks stopped and removed; database volumes retained |

The full suite ran in an isolated PostgreSQL instance with explicit test
configuration and checked identity, not the retained NixOS databases. The extra
ACL run used another isolated instance. No private SOPS bundle was read, no
native signing key was generated or changed, and no host/root commands were
executed for this implementation.

Verified API image ID:
`sha256:3a7fa5a6cd72af2f0a9e7ec397774b79f3517f48f3b4e268a76c32dfc48bfb33`.
Retained Stage 2 volumes are
`sitetrack-stage2-20261114-3ecd7f_postgres_data` (successful authenticated rehearsal)
and `sitetrack-stage2-20261114-745203_postgres_data` (preliminary healthy startup
before the final contract changes). Both were preserved without resets. Earlier
Stage 1 volumes are unchanged.

Existing foundation evidence remains in STAGE1.md. These checks establish
AUTH-01/02/03, ACL-01/02, INV-01, MEM-01, project-ID behavior and foundation
startup/restart behavior for the implemented stage. They do not establish task,
inventory, scale, ACL-03, a browser frontend, or production deployment readiness.
No independent security audit or scale benchmark was performed.
