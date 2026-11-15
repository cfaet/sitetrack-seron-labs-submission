import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"

export { RequestId, ErrorBody } from "./common.js"
import { ErrorBody } from "./common.js"
import { Accounts, Identity, ProjectsApi, TeamsApi, TasksApi } from "./contracts.js"
import { InventoryApi } from "./inventory-contracts.js"

export const Unavailable = ErrorBody.annotate({ httpApiStatus: 503 })
const InternalError = ErrorBody.annotate({ httpApiStatus: 500 })

export class HealthApi extends HttpApi.make("SiteTrack").add(
  HttpApiGroup.make("health").add(
    HttpApiEndpoint.get("live", "/health/live", {
      success: Schema.Struct({ status: Schema.Literal("ok") }),
      error: InternalError
    }),
    HttpApiEndpoint.get("ready", "/health/ready", {
      success: Schema.Struct({ status: Schema.Literal("ready") }),
      error: [Unavailable, InternalError]
    })
  )
) {}

export class Api extends HealthApi.add(Accounts, Identity, ProjectsApi, TeamsApi, TasksApi, InventoryApi)
  .annotate(
    OpenApi.Description,
    `SiteTrack is a JSON HTTP API for browsers, HTTP libraries, mobile apps, backend services and curl. It does not require a browser.

## Authentication workflow

1. Register or log in with JSON and X-CSRF-Protection: 1. The response supplies an accessToken in JSON and the sitetrack_refresh cookie through Set-Cookie.
2. Send Authorization: Bearer ACCESS_TOKEN on protected endpoints. Access tokens last 15 minutes; current session and role are checked on every request. A refresh cookie alone does not authorize these endpoints.
3. Refresh with POST /api/v1/auth/refresh, an empty JSON object {}, the custom header and the current cookie. Save the rotated cookie before refreshing again. The idle session limit is seven days, capped by a thirty-day absolute limit. A 401 from refresh requires a new login.
4. Log out with POST /api/v1/auth/logout, an empty JSON object {}, the custom header and a valid Bearer token. Refresh an expired access token first. Logout revokes that session, expires its cookie and leaves other sessions active. Discard the access token after a successful logout.

## Client requirements

Every auth POST requires application/json and X-CSRF-Protection: 1, including non-browser clients. Browsers should hold access tokens in memory and use credentials: "include" for cookie flows. HTTP libraries, mobile apps and backend services must enable a cookie jar or explicitly process Set-Cookie and send applicable Cookie name/value pairs; curl uses -c and -b. HttpOnly limits browser JavaScript access, not use by other HTTP clients.

CORS is enforced by browsers. The server also checks any supplied Origin on auth POSTs against AUTH_ALLOWED_ORIGINS; non-browser clients may omit Origin. Cross-origin browser clients need an explicitly allowed origin and credential support. The refresh cookie is host-only, HttpOnly, SameSite=Lax and scoped to /api/v1/auth; Secure is enabled by default and explicitly disabled for local HTTP Compose. Browser hosting assumes the frontend and API are on the same site. Authentication and profile responses use Cache-Control: no-store.`
  )
  .annotate(HttpApi.QueryParseOptions, { onExcessProperty: "error" })
  .annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" }) {}
