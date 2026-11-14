import { randomUUID } from "node:crypto"
import { Clock, Context, Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder, HttpApiSwagger } from "effect/http-api"
import { SqlClient } from "effect/sql"
import { DatabaseUnavailable, probeDatabase } from "../db/database.js"
import { Api, RequestId } from "./api.js"

export class DatabaseHealth extends Context.Service<DatabaseHealth, {
  readonly check: Effect.Effect<void, DatabaseUnavailable>
}>()("sitetrack/DatabaseHealth") {}

export const databaseHealthLayer = Layer.effect(DatabaseHealth, Effect.gen(function*() {
  // Capture the actual database dependency once, without creating a runtime.
  const sql = yield* SqlClient.SqlClient
  return { check: probeDatabase.pipe(Effect.provideService(SqlClient.SqlClient, sql)) }
}))

const Handlers = HttpApiBuilder.group(Api, "health", Effect.fn(function*(handlers) {
  const health = yield* DatabaseHealth
  return handlers.handleAll({
    live: () => Effect.succeed({ status: "ok" as const }),
    ready: () => Effect.gen(function*() {
      const requestId = yield* RequestId
      yield* health.check.pipe(
        Effect.timeout("2 seconds"),
        Effect.mapError(() => ({ code: "DATABASE_UNAVAILABLE", message: "Database is unavailable.", requestId }))
      )
      return { status: "ready" as const }
    })
  })
}))

const RequestMiddleware = HttpRouter.middleware<{ provides: RequestId }>()(
  (app) => Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const requestId = randomUUID()
    const started = yield* Clock.currentTimeMillis
    const response = yield* app.pipe(
      Effect.provideService(RequestId, requestId),
      Effect.catchDefect(() => Effect.gen(function*() {
        yield* Effect.logError({ event: "request_failed", requestId })
        return HttpServerResponse.jsonUnsafe({ code: "INTERNAL_ERROR", message: "Internal server error.", requestId }, { status: 500 })
      }))
    )
    const ended = yield* Clock.currentTimeMillis
    // Deliberately omit URLs/query strings, headers and bodies from logs.
    yield* Effect.logInfo({ event: "request", method: request.method, status: response.status, requestId, durationMs: ended - started })
    return HttpServerResponse.setHeader(response, "X-Request-Id", requestId)
  })
)

const NotFound = HttpRouter.add("*", "/*", Effect.gen(function*() {
  const requestId = yield* RequestId
  return HttpServerResponse.jsonUnsafe({ code: "NOT_FOUND", message: "Resource not found.", requestId }, { status: 404 })
}))

export const routes = Layer.mergeAll(
  HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(Layer.provide(Handlers)),
  HttpApiSwagger.layer(Api, { path: "/docs" }),
  NotFound
).pipe(Layer.provide(RequestMiddleware.layer))
