import { afterEach, describe, expect, it } from "vitest"
import { Effect, Layer, Schema, Logger, References } from "effect"
import { SqlError } from "effect/sql"
import { HttpRouter, HttpServer } from "effect/http"
import { DatabaseHealth, routes } from "../../src/api/routes.js"
import { ErrorBody } from "../../src/api/api.js"
import { DatabaseUnavailable } from "../../src/db/database.js"
import { execute } from "../../src/repositories/database.js"

const disposers: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()))
})

const app = (check: Effect.Effect<void, DatabaseUnavailable> = Effect.void) => {
  const server = HttpRouter.toWebHandler(
    routes.pipe(Layer.provide(Layer.succeed(DatabaseHealth, { check })), Layer.provide(HttpServer.layerServices)),
    { disableLogger: true }
  )
  disposers.push(server.dispose)
  return (path: string, headers?: HeadersInit) =>
    server.handler(new Request(`http://localhost${path}`, headers === undefined ? {} : { headers }))
}

describe("foundation HTTP contracts", () => {
  it("correlates sanitized database failures with the server-generated request id", async () => {
    const annotations: Array<Readonly<Record<string, unknown>>> = []
    const logger = Logger.make(({ fiber }) => {
      annotations.push(fiber.getRef(References.CurrentLogAnnotations))
    })
    const check = execute(
      Effect.fail(
        new SqlError.SqlError({
          reason: new SqlError.ConnectionError({
            cause: new Error("PRIVATE_SENTINEL"),
            operation: "acquireConnection"
          })
        })
      )
    ).pipe(
      Effect.mapError(() => new DatabaseUnavailable()),
      Effect.provide(Logger.layer([logger]))
    )
    const response = await app(check)("/health/ready", { "X-Request-Id": "untrusted" })
    expect(response.status).toBe(503)
    expect(annotations).toEqual([{ requestId: response.headers.get("x-request-id") }])
    expect(await response.text()).not.toContain("PRIVATE_SENTINEL")
  })
  it("liveness never queries the database", async () => {
    const response = await app(Effect.die("must not run"))("/health/live")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "ok" })
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("readiness checks the dependency and emits a fresh request id", async () => {
    let calls = 0
    const request = app(
      Effect.sync(() => {
        calls++
      })
    )
    const a = await request("/health/ready", { "X-Request-Id": "untrusted" })
    const b = await request("/health/ready")
    expect(await a.json()).toEqual({ status: "ready" })
    expect(a.status).toBe(200)
    expect(calls).toBe(2)
    expect(a.headers.get("x-request-id")).not.toBe("untrusted")
    expect(a.headers.get("x-request-id")).not.toBe(b.headers.get("x-request-id"))
  })

  it("returns a declared sanitized 503 on unavailable database", async () => {
    const response = await app(Effect.fail(new DatabaseUnavailable()))("/health/ready")
    expect(response.status).toBe(503)
    const body = Schema.decodeUnknownSync(ErrorBody)(await response.json())
    expect(body).toEqual({
      code: "DATABASE_UNAVAILABLE",
      message: "Database is unavailable.",
      requestId: response.headers.get("x-request-id")
    })
  })

  it("bounds readiness when the dependency hangs", async () => {
    const started = performance.now()
    const response = await app(Effect.never)("/health/ready")
    expect(response.status).toBe(503)
    expect(performance.now() - started).toBeLessThan(3000)
  })

  it("sanitizes defects and unknown routes", async () => {
    const response = await app(Effect.die("password=private SQL SELECT"))("/health/ready")
    expect(response.status).toBe(500)
    expect(await response.text()).not.toMatch(/private|SELECT/)
    const missing = await app()("/absent?password=private")
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({
      code: "NOT_FOUND",
      message: "Resource not found.",
      requestId: missing.headers.get("x-request-id")
    })
  })

  it("serves generated contracts and bundled docs", async () => {
    const request = app()
    const spec = await request("/openapi.json")
    expect(spec.status).toBe(200)
    const text = await spec.text()
    expect(text).toContain('"/health/live"')
    expect(text).toContain('"/health/ready"')
    expect(text).toContain('"503"')
    const docs = await request("/docs")
    expect(docs.status).toBe(200)
    expect(docs.headers.get("content-type")).toContain("text/html")
    expect(await docs.text()).toContain("SwaggerUIBundle")
  })
})
