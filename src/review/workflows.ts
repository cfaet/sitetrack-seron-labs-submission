import { randomBytes, randomUUID } from "node:crypto"
import { Effect, Schema } from "effect"
import * as M from "../domain/models.js"
import * as T from "../domain/task-models.js"
import * as I from "../domain/inventory-models.js"
import {
  ReviewFailure,
  requireReviewTarget,
  reviewError,
  reviewJson,
  reviewRequest,
  verify,
  type Account,
  type RequestOptions
} from "./client.js"

export const workflows = Effect.fn("reviewWorkflows")(function* (env: Readonly<Record<string, string | undefined>>) {
  yield* requireReviewTarget(env)
  const runId = randomUUID(),
    name = `Review ${runId}`,
    password = randomBytes(24).toString("base64url")
  const authHeaders = { "X-CSRF-Protection": "1" }
  const json = Effect.fn("workflowJSON")(function* <S extends Schema.Constraint>(
    check: string,
    method: string,
    path: string,
    status: number,
    schema: S,
    options: RequestOptions = {}
  ) {
    return (yield* reviewJson(check, method, path, status, schema, options)).body
  })
  const session = Effect.fn("workflowSession")(function* (check: string, path: string, data: unknown, actor?: Account) {
    const result = yield* reviewJson(check, "POST", path, path.endsWith("register") ? 201 : 200, M.SessionResult, {
      ...(actor ? { actor } : {}),
      data,
      headers: authHeaders
    })
    const cookie = result.headers.get("set-cookie")?.split(";")[0]
    yield* verify(cookie?.startsWith("sitetrack_refresh=") === true, "refresh cookie provided")
    yield* verify(result.headers.get("cache-control") === "no-store", "auth response not cached")
    if (cookie === undefined) return yield* new ReviewFailure({ check, message: "Refresh cookie missing." })
    const account = { token: result.body.accessToken, cookie, id: result.body.user.id, email: result.body.user.email }
    return account
  })
  const register = (label: string, role: typeof M.Role.Type) =>
    session(`register ${label}`, "/api/v1/auth/register", {
      name: `Review ${label}`,
      email: `${label}-${runId}@example.test`,
      password,
      role
    })

  yield* json("liveness", "GET", "/health/live", 200, Schema.Struct({ status: Schema.Literal("ok") }))
  yield* json("readiness", "GET", "/health/ready", 200, Schema.Struct({ status: Schema.Literal("ready") }))
  const spec = yield* json(
    "OpenAPI",
    "GET",
    "/openapi.json",
    200,
    Schema.Struct({ paths: Schema.Record(Schema.String, Schema.Unknown) }),
    { allowExtraFields: true }
  )
  for (const path of [
    "/auth/register",
    "/auth/refresh",
    "/projects",
    "/projects/{projectId}/tasks",
    "/projects/{projectId}/members",
    "/notifications",
    "/materials",
    "/company-store/stock",
    "/company-store/deliveries",
    "/deliveries/{id}/record"
  ])
    yield* verify(Object.hasOwn(spec.paths, `/api/v1${path}`), "OpenAPI workflow coverage")
  const docs = yield* reviewRequest("Swagger docs", "GET", "/docs", 200)
  const html = yield* Effect.tryPromise(() => docs.text()).pipe(
    Effect.mapError(() => new ReviewFailure({ check: "Swagger docs", message: "Cannot read documentation." }))
  )
  yield* verify(html.includes("SwaggerUIBundle") && html.includes('id="swagger-spec"'), "bundled documentation")

  const owner = yield* register("owner", "User"),
    member = yield* register("member", "User"),
    manager = yield* register("manager", "CompanyStoreManager"),
    outsider = yield* register("outsider", "User")
  const login = yield* session("login owner", "/api/v1/auth/login", { email: owner.email, password })
  yield* json("profile", "GET", "/api/v1/me", 200, M.User, { actor: owner })
  const project = yield* json("create project", "POST", "/api/v1/projects", 201, M.Project, {
    actor: owner,
    data: { name, startDate: "2020-01-01", endDate: "2099-12-31" }
  })
  const base = `/api/v1/projects/${project.id}`
  yield* verify(
    project.isAdmin && project.memberCount === 1 && project.taskCounts.total === 0,
    "initial project summary"
  )
  const hidden = yield* json(
    "outsider project list",
    "GET",
    `/api/v1/projects?search=${encodeURIComponent(name)}`,
    200,
    M.collection(M.Project),
    { actor: outsider }
  )
  yield* verify(hidden.pagination.total === 0 && hidden.items.length === 0, "project list metadata scoped")
  yield* reviewError("project hidden", "GET", base, 404, { actor: outsider })

  const invitation = yield* json("invite member", "POST", `${base}/invitations`, 201, M.Invitation, {
    actor: owner,
    data: { email: member.email }
  })
  const pending = yield* json("pending invitations", "GET", `${base}/invitations`, 200, M.collection(M.Invitation), {
    actor: owner
  })
  yield* verify(
    pending.pagination.total === 1 && pending.items[0]?.id === invitation.id,
    "pending invitation projection"
  )
  yield* reviewError("invitee has no access yet", "GET", base, 404, { actor: member })
  const notes = yield* json(
    "recipient notifications",
    "GET",
    "/api/v1/notifications",
    200,
    M.collection(M.Notification),
    { actor: member }
  )
  const note = notes.items[0]
  yield* verify(
    notes.pagination.total === 1 && note?.invitation.id === invitation.id,
    "recipient invitation notification"
  )
  const outsiderNotes = yield* json(
    "outsider notifications",
    "GET",
    "/api/v1/notifications",
    200,
    M.collection(M.Notification),
    { actor: outsider }
  )
  yield* verify(
    outsiderNotes.items.length === 0 && outsiderNotes.pagination.total === 0,
    "notification metadata scoped"
  )
  const unread = yield* json(
    "unread notification count",
    "GET",
    "/api/v1/notifications/unread-count",
    200,
    Schema.Struct({ count: Schema.Int }),
    { actor: member }
  )
  yield* verify(unread.count === 1, "unread count")
  if (note)
    yield* json(
      "mark notification read",
      "POST",
      `/api/v1/notifications/${note.id}/read`,
      200,
      Schema.Struct({ id: M.Uuid, readAt: Schema.String }),
      { actor: member, data: {} }
    )
  yield* reviewError("outsider cannot accept invitation", "POST", `/api/v1/invitations/${invitation.id}/accept`, 404, {
    actor: outsider,
    data: {}
  })
  const accepted = yield* json(
    "accept invitation",
    "POST",
    `/api/v1/invitations/${invitation.id}/accept`,
    200,
    M.Invitation,
    { actor: member, data: {} }
  )
  yield* verify(accepted.status === "Accepted", "accepted invitation state")
  yield* json("member now has access", "GET", base, 200, M.Project, { actor: member })
  const members = yield* json("project members", "GET", `${base}/members`, 200, M.collection(M.Member), {
    actor: owner
  })
  yield* verify(
    members.pagination.total === 2 && members.items.some((row) => row.id === member.id),
    "membership projection"
  )
  const memberResult = Schema.Struct({ id: M.Uuid, isAdmin: Schema.Boolean })
  for (const isAdmin of [true, false])
    yield* json(
      isAdmin ? "promote member" : "demote member",
      "PATCH",
      `${base}/members/${member.id}`,
      200,
      memberResult,
      { actor: owner, data: { isAdmin } }
    )
  yield* reviewError("preserve last admin", "PATCH", `${base}/members/${owner.id}`, 409, {
    actor: owner,
    data: { isAdmin: false }
  })
  const withdrawn = yield* json("invite outsider", "POST", `${base}/invitations`, 201, M.Invitation, {
    actor: owner,
    data: { email: outsider.email }
  })
  const withdrawnResult = yield* json(
    "withdraw invitation",
    "POST",
    `${base}/invitations/${withdrawn.id}/withdraw`,
    200,
    M.Invitation,
    { actor: owner, data: {} }
  )
  yield* verify(withdrawnResult.status === "Withdrawn", "withdrawn state")

  const tasks: Array<typeof T.TaskDetail.Type> = []
  for (const taskName of ["A", "B", "C"])
    tasks.push(
      yield* json(`create task ${taskName}`, "POST", `${base}/tasks`, 201, T.TaskDetail, {
        actor: owner,
        data: { name: taskName, startDate: "2099-01-01", endDate: "2099-12-31" }
      })
    )
  const [a, b, c] = tasks
  if (!a || !b || !c) return yield* new ReviewFailure({ check: "tasks", message: "Three tasks were not created." })
  for (const [dependent, prerequisite] of [
    [b, a],
    [c, b]
  ] as const)
    yield* json("create dependency", "POST", `${base}/tasks/${dependent.id}/dependencies`, 201, T.Dependency, {
      actor: owner,
      data: { prerequisiteTaskId: prerequisite.id }
    })
  yield* reviewError("reject dependency cycle", "POST", `${base}/tasks/${a.id}/dependencies`, 409, {
    actor: owner,
    data: { prerequisiteTaskId: c.id }
  })
  yield* reviewError("reject blocked start", "POST", `${base}/tasks/${c.id}/start`, 409, { actor: member, data: {} })
  const prerequisites = yield* json(
    "transitive prerequisites",
    "GET",
    `${base}/tasks/${c.id}/prerequisites`,
    200,
    M.collection(T.TaskRelation),
    { actor: member }
  )
  yield* verify(
    prerequisites.pagination.total === 2 &&
      prerequisites.items[0]?.id === b.id &&
      prerequisites.items[0]?.distance === 1 &&
      prerequisites.items[1]?.id === a.id &&
      prerequisites.items[1]?.distance === 2,
    "shortest prerequisite distances"
  )
  const dependents = yield* json(
    "transitive dependents",
    "GET",
    `${base}/tasks/${a.id}/dependents`,
    200,
    M.collection(T.TaskRelation),
    { actor: owner }
  )
  yield* verify(dependents.pagination.total === 2, "dependent count")
  for (const task of tasks) {
    const started = yield* json(
      `start task ${task.name}`,
      "POST",
      `${base}/tasks/${task.id}/start`,
      200,
      T.TaskDetail,
      { actor: member, data: {} }
    )
    yield* verify(started.status === "InProgress", "started state")
    const completed = yield* json(
      `complete task ${task.name}`,
      "POST",
      `${base}/tasks/${task.id}/complete`,
      200,
      T.TaskDetail,
      { actor: owner, data: {} }
    )
    yield* verify(completed.status === "Done", "completed state")
  }
  yield* reviewError("reject unsafe reopen", "POST", `${base}/tasks/${a.id}/reopen`, 409, { actor: owner, data: {} })
  const page = yield* json(
    "task filters and pagination",
    "GET",
    `${base}/tasks?status=Done&sort=id&direction=desc&pageSize=2`,
    200,
    M.collection(T.Task),
    { actor: owner }
  )
  yield* verify(
    page.pagination.total === 3 && page.items.length === 2 && page.items[0]?.id === c.id,
    "task page contents and total"
  )
  const second = yield* json(
    "second task page",
    "GET",
    `${base}/tasks?status=Done&sort=id&direction=desc&pageSize=2&page=2`,
    200,
    M.collection(T.Task),
    { actor: owner }
  )
  yield* verify(
    second.pagination.total === 3 && second.items.length === 1 && second.items[0]?.id === a.id,
    "second task page"
  )
  const projects = yield* json(
    "derived project filters",
    "GET",
    `/api/v1/projects?search=${encodeURIComponent(name)}&sort=completionPercentage&direction=desc&hasLate=false`,
    200,
    M.collection(M.Project),
    { actor: owner }
  )
  yield* verify(
    projects.pagination.total === 1 &&
      projects.items[0]?.completionPercentage === 100 &&
      projects.items[0]?.taskCounts.done === 3 &&
      projects.items[0]?.blockedCount === 0,
    "completed project summary"
  )

  const material = yield* json("create material", "POST", "/api/v1/materials", 201, I.Material, {
    actor: owner,
    data: { name, category: runId, unit: "kg" }
  })
  const catalog = yield* json(
    "material search/category",
    "GET",
    `/api/v1/materials?search=${encodeURIComponent(name)}&category=${runId}`,
    200,
    M.collection(I.Material),
    { actor: owner }
  )
  yield* verify(catalog.pagination.total === 1 && catalog.items[0]?.id === material.id, "catalogue filter")
  const stockPath = `/api/v1/company-store/stock?category=${runId}`
  const stock = () => json("company stock", "GET", stockPath, 200, M.collection(I.CompanyStock), { actor: manager })
  const addition = { materialId: material.id, quantity: "100.25" },
    key = `${runId}:addition`
  const receipt = yield* json(
    "supplier stock addition",
    "POST",
    "/api/v1/company-store/stock/additions",
    201,
    I.StockAddition,
    { actor: manager, data: addition, key }
  )
  const replay = yield* json(
    "stock addition replay",
    "POST",
    "/api/v1/company-store/stock/additions",
    201,
    I.StockAddition,
    { actor: manager, data: { ...addition, quantity: "100.250000" }, key }
  )
  yield* verify(replay.id === receipt.id && replay.quantity === "100.25", "idempotent addition")
  yield* reviewError("conflicting retry", "POST", "/api/v1/company-store/stock/additions", 409, {
    actor: manager,
    data: { ...addition, quantity: "1" },
    key
  })
  yield* reviewError("reject numeric quantity", "POST", "/api/v1/company-store/stock/additions", 400, {
    actor: manager,
    data: { ...addition, quantity: 1 }
  })
  yield* json(
    "set reorder point",
    "PUT",
    `/api/v1/company-store/stock/${material.id}/reorder-point`,
    200,
    I.CompanyStock,
    { actor: manager, data: { reorderPoint: "10" } }
  )
  const dispatch = { projectId: project.id, lines: [{ materialId: material.id, quantity: "10.25" }] }
  const sent = yield* json("dispatch company delivery", "POST", "/api/v1/company-store/deliveries", 201, I.Delivery, {
    actor: manager,
    data: dispatch,
    key: `${runId}:dispatch`
  })
  yield* verify(
    sent.status === "InTransit" && (yield* stock()).items[0]?.inTransitQuantity === "10.25",
    "in-transit stock"
  )
  const received = yield* json(
    "record project receipt",
    "POST",
    `/api/v1/deliveries/${sent.id}/record`,
    200,
    I.Delivery,
    { actor: member, data: {}, key: `${runId}:receipt` }
  )
  yield* verify(received.status === "Delivered" && received.receivedAt !== null, "delivery receipt")
  const receiptReplay = yield* json("receipt replay", "POST", `/api/v1/deliveries/${sent.id}/record`, 200, I.Delivery, {
    actor: member,
    data: {},
    key: `${runId}:receipt`
  })
  yield* verify(
    receiptReplay.id === received.id && receiptReplay.receivedAt === received.receivedAt,
    "idempotent receipt"
  )
  const dispatchReplay = yield* json(
    "dispatch replay after receipt",
    "POST",
    "/api/v1/company-store/deliveries",
    201,
    I.Delivery,
    { actor: manager, data: dispatch, key: `${runId}:dispatch` }
  )
  yield* verify(
    dispatchReplay.id === sent.id && dispatchReplay.status === "InTransit",
    "replay retains original snapshot"
  )
  yield* reviewError("reject second terminal action", "POST", `/api/v1/deliveries/${sent.id}/cancel`, 409, {
    actor: manager,
    data: {}
  })
  yield* json("rename material", "PATCH", `/api/v1/materials/${material.id}`, 200, I.Material, {
    actor: owner,
    data: { name: `Renamed ${runId}` }
  })
  const snapshot = yield* json("immutable delivery snapshot", "GET", `/api/v1/deliveries/${sent.id}`, 200, I.Delivery, {
    actor: owner
  })
  yield* verify(snapshot.lines[0]?.material.name === name, "historical material name preserved")
  const returning = yield* json("return project stock", "POST", `${base}/deliveries`, 201, I.Delivery, {
    actor: member,
    data: { lines: [{ materialId: material.id, quantity: "0.25" }] }
  })
  yield* json("record company return", "POST", `/api/v1/deliveries/${returning.id}/record`, 200, I.Delivery, {
    actor: manager,
    data: {}
  })
  for (const action of ["cancel", "reject"] as const) {
    const shipment = yield* json(
      `dispatch for ${action}`,
      "POST",
      "/api/v1/company-store/deliveries",
      201,
      I.Delivery,
      { actor: manager, data: { ...dispatch, lines: [{ materialId: material.id, quantity: "1" }] } }
    )
    const result = yield* json(
      `refund by ${action}`,
      "POST",
      `/api/v1/deliveries/${shipment.id}/${action}`,
      200,
      I.Delivery,
      { actor: action === "cancel" ? manager : member, data: {} }
    )
    yield* verify(
      result.status === (action === "cancel" ? "Cancelled" : "Rejected") && result.receivedAt === null,
      "terminal refund state"
    )
  }
  yield* reviewError("insufficient stock rolls back", "POST", "/api/v1/company-store/deliveries", 409, {
    actor: manager,
    data: { ...dispatch, lines: [{ materialId: material.id, quantity: "1000" }] }
  })
  const company = (yield* stock()).items[0]
  yield* verify(company?.quantity === "90.25" && company.inTransitQuantity === "0", "company balance conserved")
  const projectStock = yield* json(
    "project store",
    "GET",
    `${base}/store?category=${runId}&sort=quantity&direction=desc`,
    200,
    M.collection(I.ProjectStock),
    { actor: member }
  )
  yield* verify(
    projectStock.pagination.total === 1 && projectStock.items[0]?.quantity === "10",
    "project balance conserved"
  )
  for (const path of ["/company-store/deliveries", `${base.replace("/api/v1", "")}/deliveries`]) {
    const suffix = path.startsWith("/company") ? `?projectId=${project.id}` : "?pageSize=2"
    const history = yield* json("delivery list", "GET", `/api/v1${path}${suffix}`, 200, M.collection(I.Delivery), {
      actor: path.startsWith("/company") ? manager : member
    })
    yield* verify(
      history.pagination.total === 4 && !/memberCount|taskCounts|email/.test(JSON.stringify(history)),
      "delivery total and minimal projections"
    )
  }
  const date = sent.initiatedAt.slice(0, 10)
  const filtered = yield* json(
    "delivery status/direction/date filters",
    "GET",
    `/api/v1/company-store/deliveries?projectId=${project.id}&status=Delivered&direction=CompanyToProject&fromDate=${date}&toDate=${date}&pageSize=1`,
    200,
    M.collection(I.Delivery),
    { actor: manager }
  )
  yield* verify(filtered.pagination.total === 1 && filtered.items[0]?.id === sent.id, "delivery filter scope")
  const preflight = yield* reviewRequest(
    "browser CORS preflight",
    "OPTIONS",
    `/api/v1/company-store/stock/${material.id}/reorder-point`,
    204,
    {
      headers: {
        Origin: env.AUTH_ALLOWED_ORIGINS?.split(",")[0] ?? "http://localhost:3000",
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "authorization,content-type,idempotency-key"
      }
    }
  )
  yield* verify(
    preflight.headers.get("access-control-allow-methods")?.includes("PUT") === true &&
      preflight.headers.get("access-control-allow-headers")?.toLowerCase().includes("idempotency-key") === true,
    "browser write headers allowed"
  )
  yield* reviewError("outsider delivery hidden", "GET", `/api/v1/deliveries/${sent.id}`, 404, { actor: outsider })
  yield* reviewError("manager task access hidden", "GET", `${base}/tasks`, 404, { actor: manager })
  yield* reviewError("ordinary user company stock forbidden", "GET", stockPath, 403, { actor: owner })
  yield* reviewError("historical unit immutable", "PATCH", `/api/v1/materials/${material.id}`, 409, {
    actor: owner,
    data: { unit: "bag" }
  })
  yield* reviewError("stocked material deletion prevented", "DELETE", `/api/v1/materials/${material.id}`, 409, {
    actor: owner
  })
  yield* reviewError("stocked project deletion prevented", "DELETE", base, 409, { actor: owner })
  yield* reviewRequest("remove membership", "DELETE", `${base}/members/${member.id}`, 204, { actor: owner })
  yield* reviewError("membership removal immediately enforced", "GET", `${base}/store`, 404, { actor: member })

  const refreshed = yield* session("rotate refresh cookie", "/api/v1/auth/refresh", {}, owner)
  yield* reviewError("refresh replay rejected", "POST", "/api/v1/auth/refresh", 401, {
    actor: owner,
    data: {},
    headers: authHeaders
  })
  yield* json("refresh winner remains valid", "GET", "/api/v1/me", 200, M.User, { actor: refreshed })
  yield* reviewRequest("logout refreshed session", "POST", "/api/v1/auth/logout", 204, {
    actor: refreshed,
    data: {},
    headers: authHeaders
  })
  yield* reviewError("revoked access rejected", "GET", "/api/v1/me", 401, { actor: refreshed })
  yield* reviewError("revoked refresh rejected", "POST", "/api/v1/auth/refresh", 401, {
    actor: refreshed,
    data: {},
    headers: authHeaders
  })
  yield* json("other login survives logout", "GET", "/api/v1/me", 200, M.User, { actor: login })
  // The owner and refreshed account refer to the same session, now revoked.
  for (const actor of [login, member, manager, outsider])
    yield* reviewRequest("logout demo session", "POST", "/api/v1/auth/logout", 204, {
      actor,
      data: {},
      headers: authHeaders
    })
  return { event: "workflow_passed", runId, projectId: project.id, materialId: material.id, sessions: "revoked" }
})
