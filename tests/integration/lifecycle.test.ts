import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { once } from "node:events"
import { describe, expect, it } from "vitest"
import { Deferred, Effect, Fiber, Layer, Redacted } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { Migrator, SqlClient } from "effect/sql"
import { databaseHealthLayer, routes } from "../../src/api/routes.js"
import { initializeDatabase } from "../../src/db/migrate.js"
import { serverLayer } from "../../src/server.js"
import { withTestDatabase } from "./database-fixture.js"

const freePort = async () => {
  const server = createServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("No test port allocated")
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}

const request = (port: number) => fetch(`http://127.0.0.1:${port}/health/ready`, { signal: AbortSignal.timeout(3000) })

const boundedExit = async (exited: Promise<unknown>) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      exited,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Shutdown exceeded 12 seconds")), 12000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

describe("real startup and resource lifecycle (BOOT-02)", () => {
  it("does not bind before migration completion, then serves HTTP and releases the port", async () => {
    await Effect.runPromise(
      withTestDatabase((config) =>
        Effect.gen(function* () {
          const port = yield* Effect.promise(freePort)
          yield* Effect.scoped(
            Effect.gen(function* () {
              const entered = yield* Deferred.make<void>()
              const release = yield* Deferred.make<void>()
              const loader = Migrator.fromRecord({
                "0001_gate": Effect.gen(function* () {
                  yield* Deferred.succeed(entered, undefined)
                  yield* Deferred.await(release)
                })
              })
              const building = yield* Layer.build(serverLayer({ ...config, port }, loader)).pipe(Effect.forkScoped)
              yield* Deferred.await(entered)
              yield* Effect.promise(async () => {
                await expect(request(port)).rejects.toThrow()
              })
              yield* Deferred.succeed(release, undefined)
              yield* Fiber.join(building)
              yield* Effect.promise(async () => {
                expect((await request(port)).status).toBe(200)
              })
            })
          )
          yield* Effect.promise(async () => {
            await expect(request(port)).rejects.toThrow()
          })
        })
      )
    )
  })

  it("never listens after a broken migration", async () => {
    await Effect.runPromise(
      withTestDatabase((config) =>
        Effect.gen(function* () {
          const port = yield* Effect.promise(freePort)
          const loader = Migrator.fromRecord({ "0001_broken": Effect.fail(new Error("broken")) })
          const failure = yield* Layer.build(serverLayer({ ...config, port }, loader)).pipe(Effect.flip)
          expect(failure._tag).toBe("StartupError")
          yield* Effect.promise(async () => {
            await expect(request(port)).rejects.toThrow()
          })
        })
      )
    )
  })

  it("fails cleanly when the configured HTTP port is already occupied", async () => {
    await Effect.runPromise(
      withTestDatabase((config) =>
        Effect.gen(function* () {
          const occupied = yield* Effect.acquireRelease(
            Effect.promise(async () => {
              const socket = createServer()
              socket.listen(0, "127.0.0.1")
              await once(socket, "listening")
              return socket
            }),
            (socket) =>
              Effect.promise(
                () =>
                  new Promise<void>((resolve, reject) => socket.close((error) => (error ? reject(error) : resolve())))
              )
          )
          const address = occupied.address()
          if (address === null || typeof address === "string") throw new Error("No occupied test port")
          const failure = yield* Effect.scoped(Layer.build(serverLayer({ ...config, port: address.port }))).pipe(
            Effect.flip
          )
          expect(failure._tag).toBe("ServeError")
        })
      )
    )
  })

  it("bounds a real unavailable-database startup", async () => {
    await Effect.runPromise(
      withTestDatabase((config) =>
        Effect.gen(function* () {
          const port = yield* Effect.promise(freePort)
          const url = new URL(Redacted.value(config.databaseUrl))
          url.port = String(port)
          const started = performance.now()
          const failure = yield* Effect.scoped(
            Layer.build(serverLayer({ ...config, databaseUrl: Redacted.make(url.toString()) }))
          ).pipe(Effect.flip)
          expect(failure._tag).toBe("StartupError")
          expect(performance.now() - started).toBeLessThan(35000)
        })
      )
    )
  })

  it("bounds readiness under pool exhaustion and recovers without restarting", async () => {
    await Effect.runPromise(
      withTestDatabase((config) =>
        Effect.gen(function* () {
          yield* initializeDatabase(config)
          const sql = yield* SqlClient.SqlClient
          const release = yield* Deferred.make<void>()
          const holders = []
          for (let i = 0; i < 5; i++) {
            const entered = yield* Deferred.make<void>()
            const fiber = yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* Deferred.succeed(entered, undefined)
                  yield* Deferred.await(release)
                })
              )
              .pipe(Effect.forkScoped)
            holders.push(fiber)
            yield* Deferred.await(entered)
          }
          const context = yield* Effect.context<SqlClient.SqlClient>()
          const web = HttpRouter.toWebHandler(
            routes.pipe(
              Layer.provide(databaseHealthLayer),
              Layer.provide(Layer.succeedContext(context)),
              Layer.provide(HttpServer.layerServices)
            ),
            { disableLogger: true }
          )
          yield* Effect.addFinalizer(() => Effect.promise(web.dispose))
          const started = performance.now()
          yield* Effect.promise(async () => {
            expect((await web.handler(new Request("http://localhost/health/ready"))).status).toBe(503)
            expect(performance.now() - started).toBeLessThan(3000)
            expect((await web.handler(new Request("http://localhost/health/live"))).status).toBe(200)
          })
          yield* Deferred.succeed(release, undefined)
          for (const holder of holders) yield* Fiber.join(holder)
          yield* Effect.promise(async () => {
            expect((await web.handler(new Request("http://localhost/health/ready"))).status).toBe(200)
          })
        })
      )
    )
  })

  it("handles SIGTERM, closes its connections, and preserves data across restart", async () => {
    await Effect.runPromise(
      withTestDatabase((config) =>
        Effect.gen(function* () {
          yield* initializeDatabase(config)
          const sql = yield* SqlClient.SqlClient
          expect(yield* sql`SELECT nextval('project_number_seq')::text AS number`).toEqual([{ number: "1" }])
          const before =
            yield* sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = ${`sitetrack:${config.schema}`}`
          const port = yield* Effect.promise(freePort)
          yield* Effect.promise(async () => {
            for (let attempt = 0; attempt < 2; attempt++) {
              const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
                env: {
                  AUTH_JWT_SECRET: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc",
                  PATH: process.env.PATH,
                  DATABASE_URL: Redacted.value(config.databaseUrl),
                  DATABASE_SCHEMA: config.schema,
                  HOST: "127.0.0.1",
                  PORT: String(port)
                },
                stdio: "ignore"
              })
              const exited = once(child, "exit")
              try {
                const deadline = Date.now() + 30000
                let ready = false
                while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
                  try {
                    ready = (await request(port)).status === 200
                  } catch {
                    /* startup connection refusal is expected */
                  }
                  if (ready) break
                  await new Promise((resolve) => setTimeout(resolve, 50))
                }
                expect(ready).toBe(true)
                child.kill("SIGTERM")
                expect(await boundedExit(exited)).toEqual([0, null])
                await expect(request(port)).rejects.toThrow()
              } finally {
                if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
                await exited
              }
            }
          })
          expect(yield* sql`SELECT nextval('project_number_seq')::text AS number`).toEqual([{ number: "2" }])
          const after =
            yield* sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = ${`sitetrack:${config.schema}`}`
          expect(after).toEqual(before)
        })
      )
    )
  })
})
