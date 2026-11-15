import { Context, Schema } from "effect"
import {
  HttpApiEndpoint as Endpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
  OpenApi
} from "effect/http-api"
import * as Model from "../domain/models.js"
import { errors } from "./common.js"

const refreshSecurity = HttpApiSecurity.apiKey({ key: "sitetrack_refresh", in: "cookie" }).pipe(
  HttpApiSecurity.annotate(
    OpenApi.Description,
    "Refresh credential supplied in the sitetrack_refresh cookie. Browsers send it automatically with credentials enabled; other HTTP clients must retain and send it using a cookie jar or Cookie header. Login/registration set it, refresh rotates it, and logout expires it. It is never returned in JSON and does not authorize ordinary protected endpoints."
  )
)
const bearerSecurity = HttpApiSecurity.bearer.pipe(
  HttpApiSecurity.annotate(
    OpenApi.Description,
    "15-minute JWT access token returned by registration, login or refresh. Send Authorization: Bearer ACCESS_TOKEN on protected endpoints, including logout. Current session and role are checked on every request. Refresh cookies alone do not authorize these endpoints."
  )
)
export class RefreshCredential extends Context.Service<RefreshCredential, string>()("sitetrack/RefreshCredential") {}
export class RefreshCookie extends HttpApiMiddleware.Service<RefreshCookie, { provides: RefreshCredential }>()(
  "sitetrack/RefreshCookie",
  { security: { refreshCookie: refreshSecurity }, error: errors }
) {}
export class CurrentActor extends Context.Service<CurrentActor, Model.Actor>()("sitetrack/CurrentActor") {}
export class Authentication extends HttpApiMiddleware.Service<Authentication, { provides: CurrentActor }>()(
  "sitetrack/Authentication",
  { security: { bearer: bearerSecurity }, error: errors }
) {}

const authHeaders = {
  "x-csrf-protection": Schema.Literal("1").annotate({
    description:
      "Required literal value 1 on every auth POST, including curl, mobile apps and backend clients. This is not a secret. Any supplied Origin must match AUTH_ALLOWED_ORIGINS; non-browser clients can omit Origin."
  })
}
const sessionHeaders = {
  "set-cookie": Schema.String.annotate({
    description:
      "Sets, rotates or expires the HttpOnly sitetrack_refresh cookie. Let a cookie jar process this response header; send only applicable cookie name/value pairs in subsequent Cookie request headers."
  }),
  "cache-control": Schema.String.annotate({ description: "no-store: authentication responses must not be cached." })
}
const authPostGuidance =
  "Send application/json and X-CSRF-Protection: 1. Browser clients must enable credentials and use an allowed Origin. Any HTTP client may call this endpoint; non-browser clients can omit Origin. Authentication responses use Cache-Control: no-store."

export const Accounts = HttpApiGroup.make("accounts")
  .add(
    Endpoint.post("register", "/api/v1/auth/register", {
      headers: authHeaders,
      payload: Model.Register,
      success: HttpApiSchema.WithHeaders(Model.SessionResult.annotate({ httpApiStatus: 201 }), sessionHeaders),
      error: errors
    })
      .annotate(OpenApi.Summary, "Register an account and create a session")
      .annotate(
        OpenApi.Description,
        `Registration accepts any one of the three assignment roles. Returns the user, a 15-minute accessToken and expiry metadata in JSON, and sets the refresh cookie through Set-Cookie. Retain both the access token and cookie; refresh credentials are never returned in JSON. ${authPostGuidance}`
      ),
    Endpoint.post("login", "/api/v1/auth/login", {
      headers: authHeaders,
      payload: Model.Login,
      success: HttpApiSchema.WithHeaders(Model.SessionResult, sessionHeaders),
      error: errors
    })
      .annotate(OpenApi.Summary, "Log in and create a separate session")
      .annotate(
        OpenApi.Description,
        `Returns a 15-minute accessToken in JSON and a refresh cookie through Set-Cookie. Existing sessions remain active. Failed login uses the same generic 401 for an unknown email or wrong password. Use a cookie jar for HTTP libraries and curl (-c to save cookies, -b to send them). ${authPostGuidance}`
      ),
    Endpoint.post("refresh", "/api/v1/auth/refresh", {
      headers: authHeaders,
      payload: Model.Empty,
      success: HttpApiSchema.WithHeaders(Model.SessionResult, sessionHeaders),
      error: errors
    })
      .middleware(RefreshCookie)
      .annotate(OpenApi.Summary, "Rotate the refresh cookie and issue a new access token")
      .annotate(
        OpenApi.Description,
        `Send an empty JSON object {} and the current sitetrack_refresh cookie; no Bearer token is required. Store the replacement Set-Cookie before another refresh. Serialize refresh attempts: only one use of a credential succeeds; replay returns 401 without revoking the winner. Refresh extends the seven-day idle deadline up to the thirty-day absolute session limit. accessTokenExpiresAt describes JWT expiry, refreshExpiresAt the idle deadline, and sessionExpiresAt the absolute deadline. If refresh returns 401, log in again instead of retrying the same cookie. ${authPostGuidance}`
      )
  )
  .annotate(
    OpenApi.Description,
    "Account and session creation for any HTTP client. Access tokens are JSON values; refresh credentials are cookies. See the API overview for the complete client workflow."
  )

export const Identity = HttpApiGroup.make("identity")
  .add(
    Endpoint.get("me", "/api/v1/me", { success: Model.User, error: errors })
      .annotate(OpenApi.Summary, "Read the authenticated user's current profile")
      .annotate(
        OpenApi.Description,
        "Send the Bearer access token. The response reflects the current database role and session state, without requiring token replacement after a role change. A refresh cookie alone is insufficient. Responses use Cache-Control: no-store."
      ),
    Endpoint.post("logout", "/api/v1/auth/logout", {
      headers: authHeaders,
      payload: Model.Empty,
      success: HttpApiSchema.WithHeaders(HttpApiSchema.NoContent, sessionHeaders),
      error: errors
    })
      .annotate(OpenApi.Summary, "Revoke the Bearer token's session and expire its refresh cookie")
      .annotate(
        OpenApi.Description,
        `Send an empty JSON object {} and a valid Bearer access token. Refresh an expired access token first. A successful 204 revokes this session immediately and expires its refresh cookie through Set-Cookie; other sessions remain valid. Process the cookie response and discard the local access token. Cookie-only logout is not supported. ${authPostGuidance}`
      )
  )
  .middleware(Authentication)
  .annotate(
    OpenApi.Description,
    "Bearer-authenticated profile and logout operations. These endpoints are available to browsers, HTTP libraries, mobile apps, backend services and curl."
  )
const projectParams = { projectId: Model.ProjectId }
export const ProjectsApi = HttpApiGroup.make("projects")
  .add(
    Endpoint.get("list", "/api/v1/projects", {
      query: Model.ProjectQuery,
      success: Model.collection(Model.Project),
      error: errors
    }),
    Endpoint.post("create", "/api/v1/projects", {
      payload: Model.ProjectInput,
      success: Model.Project.annotate({ httpApiStatus: 201 }),
      error: errors
    }),
    Endpoint.get("get", "/api/v1/projects/:projectId", {
      params: projectParams,
      success: Model.Project,
      error: errors
    }),
    Endpoint.patch("update", "/api/v1/projects/:projectId", {
      params: projectParams,
      payload: Model.ProjectPatch,
      success: Model.Project,
      error: errors
    }),
    Endpoint.delete("remove", "/api/v1/projects/:projectId", { params: projectParams, error: errors })
  )
  .middleware(Authentication)
export const TeamsApi = HttpApiGroup.make("teams")
  .add(
    Endpoint.get("members", "/api/v1/projects/:projectId/members", {
      params: projectParams,
      query: Model.ListQuery,
      success: Model.collection(Model.Member),
      error: errors
    }),
    Endpoint.patch("changeMember", "/api/v1/projects/:projectId/members/:userId", {
      params: { ...projectParams, userId: Model.Uuid },
      payload: Model.MemberPatch,
      success: Schema.Struct({ id: Model.Uuid, isAdmin: Schema.Boolean }),
      error: errors
    }),
    Endpoint.delete("removeMember", "/api/v1/projects/:projectId/members/:userId", {
      params: { ...projectParams, userId: Model.Uuid },
      error: errors
    }),
    Endpoint.get("invitations", "/api/v1/projects/:projectId/invitations", {
      params: projectParams,
      query: Model.ListQuery,
      success: Model.collection(Model.Invitation),
      error: errors
    }),
    Endpoint.post("invite", "/api/v1/projects/:projectId/invitations", {
      params: projectParams,
      payload: Model.InviteInput,
      success: Model.Invitation.annotate({ httpApiStatus: 201 }),
      error: errors
    }),
    Endpoint.post("withdraw", "/api/v1/projects/:projectId/invitations/:id/withdraw", {
      params: { ...projectParams, id: Model.Uuid },
      payload: Model.Empty,
      success: Model.Invitation,
      error: errors
    }),
    Endpoint.post("accept", "/api/v1/invitations/:id/accept", {
      params: { id: Model.Uuid },
      payload: Model.Empty,
      success: Model.Invitation,
      error: errors
    }),
    Endpoint.post("reject", "/api/v1/invitations/:id/reject", {
      params: { id: Model.Uuid },
      payload: Model.Empty,
      success: Model.Invitation,
      error: errors
    }),
    Endpoint.get("notifications", "/api/v1/notifications", {
      query: Model.ListQuery,
      success: Model.collection(Model.Notification),
      error: errors
    }),
    Endpoint.get("unread", "/api/v1/notifications/unread-count", {
      success: Schema.Struct({ count: Schema.Int }),
      error: errors
    }),
    Endpoint.post("read", "/api/v1/notifications/:id/read", {
      params: { id: Model.Uuid },
      payload: Model.Empty,
      success: Schema.Struct({ id: Model.Uuid, readAt: Schema.String }),
      error: errors
    })
  )
  .middleware(Authentication)
