import { Duration, Effect, Layer, Option, Redacted } from "effect"
import { HttpRouter, HttpMiddleware, HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { AuthSettings } from "../config/auth.js"
import { AppError, forbidden } from "../domain/errors.js"
import * as Model from "../domain/models.js"
import { Auth } from "../services/auth.js"
import { Projects } from "../services/projects.js"
import { Teams } from "../services/teams.js"
import { Tasks } from "../services/tasks.js"
import * as TaskModel from "../domain/task-models.js"
import { Throttle } from "../services/security.js"
import { Api } from "./api.js"
import { Authentication, CurrentActor, RefreshCookie, RefreshCredential } from "./contracts.js"
import { errorResponseFor, jsonResponse } from "./common.js"
import { guarded, readInput } from "./input.js"
import { InventoryHandlers } from "./inventory.js"
export { readInput } from "./input.js"
const csrf = Effect.fn("csrf")(function* (request: HttpServerRequest.HttpServerRequest) {
  const settings = yield* AuthSettings,
    origin = request.headers.origin
  if (request.headers["x-csrf-protection"] !== "1" || (origin !== undefined && !settings.origins.includes(origin)))
    return yield* forbidden()
})
const sessionResponse = Effect.fn("sessionResponse")(function* (
  result: Effect.Success<ReturnType<Auth["Service"]["login"]>>,
  status = 200
) {
  const config = yield* AuthSettings
  const response = yield* jsonResponse(Model.SessionResult, result.body, status)
  return yield* HttpServerResponse.setCookie(
    HttpServerResponse.setHeader(response, "Cache-Control", "no-store"),
    "sitetrack_refresh",
    result.refresh,
    {
      httpOnly: true,
      secure: config.secureCookie,
      sameSite: "lax",
      path: "/api/v1/auth",
      maxAge: Duration.seconds(result.maxAge)
    }
  ).pipe(Effect.orDie)
})
export const AuthenticationLayer = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const auth = yield* Auth
    return Authentication.of({
      bearer: (http, { credential }) =>
        Effect.gen(function* () {
          const actor = yield* auth.authorize(Redacted.value(credential))
          return yield* Effect.provideService(http, CurrentActor, actor)
        }).pipe(
          Effect.catchIf(
            (error): error is AppError => error instanceof AppError,
            (error) =>
              Effect.gen(function* () {
                const request = yield* HttpServerRequest.HttpServerRequest
                const id = request.headers["x-request-id"]
                if (id === undefined) return yield* Effect.die(new Error("Missing server request ID"))
                return yield* errorResponseFor(error, id)
              })
          )
        )
    })
  })
)
export const AccountHandlers = HttpApiBuilder.group(Api, "accounts", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* Auth,
      throttle = yield* Throttle
    return handlers
      .handleRaw("register", ({ request }) =>
        guarded(
          Effect.gen(function* () {
            yield* csrf(request)
            yield* throttle.admit(
              "register",
              Option.getOrElse(request.peerAddress, () => "unknown")
            )
            return yield* sessionResponse(yield* auth.register(yield* readInput(Model.Register, request)), 201)
          })
        )
      )
      .handleRaw("login", ({ request }) =>
        guarded(
          Effect.gen(function* () {
            yield* csrf(request)
            yield* throttle.admit(
              "login",
              Option.getOrElse(request.peerAddress, () => "unknown")
            )
            return yield* sessionResponse(yield* auth.login(yield* readInput(Model.Login, request)))
          })
        )
      )
      .handleRaw("refresh", ({ request }) =>
        guarded(
          Effect.gen(function* () {
            yield* csrf(request)
            yield* readInput(Model.Empty, request)
            return yield* sessionResponse(yield* auth.refresh(yield* RefreshCredential))
          })
        )
      )
  })
)
export const IdentityHandlers = HttpApiBuilder.group(Api, "identity", (handlers) =>
  handlers
    .handle("me", () => Effect.map(CurrentActor, (actor) => actor.user))
    .handleRaw("logout", ({ request }) =>
      guarded(
        Effect.gen(function* () {
          yield* csrf(request)
          yield* readInput(Model.Empty, request)
          const auth = yield* Auth,
            actor = yield* CurrentActor,
            config = yield* AuthSettings
          yield* auth.logout(actor)
          return yield* HttpServerResponse.setCookie(
            HttpServerResponse.empty({ status: 204 }),
            "sitetrack_refresh",
            "",
            {
              httpOnly: true,
              secure: config.secureCookie,
              sameSite: "lax",
              path: "/api/v1/auth",
              maxAge: 0,
              expires: new Date(0)
            }
          ).pipe(Effect.orDie)
        })
      )
    )
)
export const ProjectHandlers = HttpApiBuilder.group(Api, "projects", (handlers) =>
  handlers
    .handle("list", ({ query }) =>
      guarded(
        Effect.gen(function* () {
          return yield* jsonResponse(
            Model.collection(Model.Project),
            yield* (yield* Projects).list(yield* CurrentActor, query)
          )
        })
      )
    )
    .handleRaw("create", ({ request }) =>
      guarded(
        Effect.gen(function* () {
          return yield* jsonResponse(
            Model.Project,
            yield* (yield* Projects).create(yield* CurrentActor, yield* readInput(Model.ProjectInput, request)),
            201
          )
        })
      )
    )
    .handle("get", ({ params }) =>
      guarded(
        Effect.gen(function* () {
          return yield* jsonResponse(Model.Project, yield* (yield* Projects).get(yield* CurrentActor, params.projectId))
        })
      )
    )
    .handleRaw("update", ({ params, request }) =>
      guarded(
        Effect.gen(function* () {
          return yield* jsonResponse(
            Model.Project,
            yield* (yield* Projects).update(
              yield* CurrentActor,
              params.projectId,
              yield* readInput(Model.ProjectPatch, request)
            )
          )
        })
      )
    )
    .handle("remove", ({ params }) =>
      guarded(
        Effect.gen(function* () {
          yield* (yield* Projects).remove(yield* CurrentActor, params.projectId)
          return HttpServerResponse.empty({ status: 204 })
        })
      )
    )
)
export const TeamHandlers = HttpApiBuilder.group(Api, "teams", (handlers) =>
  handlers
    .handle("members", ({ params, query }) =>
      guarded(
        Effect.gen(function* () {
          return yield* jsonResponse(
            Model.collection(Model.Member),
            yield* (yield* Teams).memberList(yield* CurrentActor, params.projectId, query)
          )
        })
      )
    )
    .handleRaw("changeMember", ({ params, request }) =>
      guarded(
        Effect.gen(function* () {
          const input = yield* readInput(Model.MemberPatch, request)
          yield* (yield* Teams).changeMember(yield* CurrentActor, params.projectId, params.userId, input.isAdmin)
          return { id: params.userId, isAdmin: input.isAdmin }
        })
      )
    )
    .handle("removeMember", ({ params }) =>
      guarded(
        Effect.gen(function* () {
          yield* (yield* Teams).changeMember(yield* CurrentActor, params.projectId, params.userId, undefined)
          return HttpServerResponse.empty({ status: 204 })
        })
      )
    )
    .handle("invitations", ({ params, query }) =>
      guarded(
        Effect.gen(function* () {
          return yield* jsonResponse(
            Model.collection(Model.Invitation),
            yield* (yield* Teams).invitations(yield* CurrentActor, params.projectId, query)
          )
        })
      )
    )
    .handleRaw("invite", ({ params, request }) =>
      guarded(
        Effect.gen(function* () {
          return yield* jsonResponse(
            Model.Invitation,
            yield* (yield* Teams).invite(
              yield* CurrentActor,
              params.projectId,
              (yield* readInput(Model.InviteInput, request)).email
            ),
            201
          )
        })
      )
    )
    .handleRaw("withdraw", ({ params, request }) =>
      guarded(
        Effect.gen(function* () {
          yield* readInput(Model.Empty, request)
          return yield* jsonResponse(
            Model.Invitation,
            yield* (yield* Teams).withdraw(yield* CurrentActor, params.projectId, params.id)
          )
        })
      )
    )
    .handleRaw("accept", ({ params, request }) =>
      guarded(
        Effect.gen(function* () {
          yield* readInput(Model.Empty, request)
          return yield* jsonResponse(
            Model.Invitation,
            yield* (yield* Teams).answer(yield* CurrentActor, params.id, true)
          )
        })
      )
    )
    .handleRaw("reject", ({ params, request }) =>
      guarded(
        Effect.gen(function* () {
          yield* readInput(Model.Empty, request)
          return yield* jsonResponse(
            Model.Invitation,
            yield* (yield* Teams).answer(yield* CurrentActor, params.id, false)
          )
        })
      )
    )
    .handle("notifications", ({ query }) =>
      guarded(
        Effect.gen(function* () {
          return yield* jsonResponse(
            Model.collection(Model.Notification),
            yield* (yield* Teams).notifications(yield* CurrentActor, query)
          )
        })
      )
    )
    .handle("unread", () =>
      guarded(
        Effect.gen(function* () {
          return yield* (yield* Teams).unread(yield* CurrentActor)
        })
      )
    )
    .handleRaw("read", ({ params, request }) =>
      guarded(
        Effect.gen(function* () {
          yield* readInput(Model.Empty, request)
          return yield* (yield* Teams).markRead(yield* CurrentActor, params.id)
        })
      )
    )
)
const RefreshCookieLayer = Layer.succeed(
  RefreshCookie,
  RefreshCookie.of({
    refreshCookie: (http, { credential }) => Effect.provideService(http, RefreshCredential, Redacted.value(credential))
  })
)
export const TaskHandlers = HttpApiBuilder.group(Api, "tasks", (handlers) =>
  handlers
    .handle("list", ({ params, query }) =>
      guarded(
        Effect.gen(function* () {
          return yield* jsonResponse(
            Model.collection(TaskModel.Task),
            yield* (yield* Tasks).list(yield* CurrentActor, params.projectId, query)
          )
        })
      )
    )
    .handle("get", ({ params }) =>
      guarded(
        Effect.gen(function* () {
          return yield* jsonResponse(
            TaskModel.TaskDetail,
            yield* (yield* Tasks).get(yield* CurrentActor, params.projectId, params.taskId)
          )
        })
      )
    )
    .handleRaw("create", ({ params, request }) =>
      guarded(
        Effect.gen(function* () {
          return yield* jsonResponse(
            TaskModel.TaskDetail,
            yield* (yield* Tasks).create(
              yield* CurrentActor,
              params.projectId,
              yield* readInput(TaskModel.TaskInput, request)
            ),
            201
          )
        })
      )
    )
    .handleRaw("update", ({ params, request }) =>
      guarded(
        Effect.gen(function* () {
          return yield* jsonResponse(
            TaskModel.TaskDetail,
            yield* (yield* Tasks).update(
              yield* CurrentActor,
              params.projectId,
              params.taskId,
              yield* readInput(TaskModel.TaskPatch, request)
            )
          )
        })
      )
    )
    .handle("remove", ({ params }) =>
      guarded(
        Effect.gen(function* () {
          yield* (yield* Tasks).remove(yield* CurrentActor, params.projectId, params.taskId)
          return HttpServerResponse.empty({ status: 204 })
        })
      )
    )
    .handleRaw("start", ({ params, request }) =>
      guarded(
        Effect.gen(function* () {
          yield* readInput(Model.Empty, request)
          return yield* jsonResponse(
            TaskModel.TaskDetail,
            yield* (yield* Tasks).action(yield* CurrentActor, params.projectId, params.taskId, "start")
          )
        })
      )
    )
    .handleRaw("complete", ({ params, request }) =>
      guarded(
        Effect.gen(function* () {
          yield* readInput(Model.Empty, request)
          return yield* jsonResponse(
            TaskModel.TaskDetail,
            yield* (yield* Tasks).action(yield* CurrentActor, params.projectId, params.taskId, "complete")
          )
        })
      )
    )
    .handleRaw("reopen", ({ params, request }) =>
      guarded(
        Effect.gen(function* () {
          yield* readInput(Model.Empty, request)
          return yield* jsonResponse(
            TaskModel.TaskDetail,
            yield* (yield* Tasks).action(yield* CurrentActor, params.projectId, params.taskId, "reopen")
          )
        })
      )
    )
    .handleRaw("addDependency", ({ params, request }) =>
      guarded(
        Effect.gen(function* () {
          const input = yield* readInput(TaskModel.DependencyInput, request)
          return yield* jsonResponse(
            TaskModel.Dependency,
            yield* (yield* Tasks).addDependency(
              yield* CurrentActor,
              params.projectId,
              params.taskId,
              input.prerequisiteTaskId
            ),
            201
          )
        })
      )
    )
    .handle("removeDependency", ({ params }) =>
      guarded(
        Effect.gen(function* () {
          yield* (yield* Tasks).removeDependency(
            yield* CurrentActor,
            params.projectId,
            params.taskId,
            params.prerequisiteId
          )
          return HttpServerResponse.empty({ status: 204 })
        })
      )
    )
    .handle("prerequisites", ({ params, query }) =>
      guarded(
        Effect.gen(function* () {
          return yield* jsonResponse(
            Model.collection(TaskModel.TaskRelation),
            yield* (yield* Tasks).relations(
              yield* CurrentActor,
              params.projectId,
              params.taskId,
              "prerequisites",
              query
            )
          )
        })
      )
    )
    .handle("dependents", ({ params, query }) =>
      guarded(
        Effect.gen(function* () {
          return yield* jsonResponse(
            Model.collection(TaskModel.TaskRelation),
            yield* (yield* Tasks).relations(yield* CurrentActor, params.projectId, params.taskId, "dependents", query)
          )
        })
      )
    )
)
export const featureHandlers = Layer.mergeAll(
  AccountHandlers,
  IdentityHandlers,
  ProjectHandlers,
  TeamHandlers,
  TaskHandlers,
  InventoryHandlers
).pipe(Layer.provide([AuthenticationLayer, RefreshCookieLayer]))
export const browserMiddleware = HttpRouter.middleware(
  Effect.gen(function* () {
    const config = yield* AuthSettings
    return HttpMiddleware.cors({
      allowedOrigins: config.origins,
      credentials: true,
      allowedHeaders: ["Authorization", "Content-Type", "X-CSRF-Protection", "Idempotency-Key"],
      exposedHeaders: ["X-Request-Id", "Retry-After"],
      allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
    })
  })
)
