import { describe, expect, it } from "vitest"
import { Effect, Fiber, Logger, References } from "effect"
import { SqlClient } from "effect/sql"
import { execute } from "../../src/repositories/database.js"
import { withTestDatabase } from "./database-fixture.js"

describe("real PostgreSQL failure diagnostics", () => {
  it("identifies acquisition and statement timeouts without exposing SQL", async () => {
    const captured: Array<unknown> = []
    const logger = Logger.make(({ message, fiber }) => {
      captured.push({ message, annotations: fiber.getRef(References.CurrentLogAnnotations) })
    })
    await Effect.runPromise(
      withTestDatabase(() =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          let acquired = 0
          let ready: () => void = () => {}
          let release: () => void = () => {}
          const entered = new Promise<void>((resolve) => {
            ready = resolve
          })
          const released = new Promise<void>((resolve) => {
            release = resolve
          })
          const holders = yield* Effect.all(
            Array.from({ length: 5 }, () =>
              sql.withTransaction(
                Effect.gen(function* () {
                  acquired++
                  if (acquired === 5) ready()
                  yield* Effect.promise(() => released)
                })
              )
            ),
            { concurrency: "unbounded" }
          ).pipe(Effect.forkChild)
          try {
            yield* Effect.promise(() => entered).pipe(Effect.timeout("10 seconds"))
            expect((yield* execute(sql`SELECT 1`).pipe(Effect.exit))._tag).toBe("Failure")
          } finally {
            release()
            yield* Fiber.join(holders)
          }
          const result = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`SET LOCAL statement_timeout='50ms'`
                return yield* execute(sql`SELECT pg_sleep(1) /* PRIVATE_SQL_SENTINEL */`)
              })
            )
            .pipe(Effect.exit)
          expect(result._tag).toBe("Failure")
        })
      ).pipe(Effect.annotateLogs({ requestId: "database-regression" }), Effect.provide(Logger.layer([logger])))
    )
    const text = JSON.stringify(captured)
    expect(text).toContain("connection_acquisition")
    expect(text).toContain("statement_timeout")
    expect(text).toContain("database-regression")
    expect(text).not.toContain("PRIVATE_SQL_SENTINEL")
    expect(text).not.toContain("pg_sleep")
  })
})
