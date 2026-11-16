import { describe, expect, it } from "vitest"
import { Effect, Logger, References } from "effect"
import { SqlError } from "effect/sql"
import { execute } from "../../src/repositories/database.js"

describe("sanitized database failure diagnostics", () => {
  it("classifies failures without logging private causes, messages or operations", async () => {
    const captured: Array<unknown> = []
    const logger = Logger.make(({ message, fiber }) => {
      captured.push({ message, annotations: fiber.getRef(References.CurrentLogAnnotations) })
    })
    const privateFields = { cause: new Error("PRIVATE_SENTINEL"), message: "PRIVATE_SENTINEL" }
    const reasons = [
      new SqlError.ConnectionError({ ...privateFields, operation: "acquireConnection" }),
      new SqlError.StatementTimeoutError(privateFields),
      new SqlError.LockTimeoutError(privateFields),
      new SqlError.UnknownError({ ...privateFields, operation: "PRIVATE_SENTINEL" })
    ]
    for (const reason of reasons) {
      const result = await Effect.runPromise(
        execute(Effect.fail(new SqlError.SqlError({ reason }))).pipe(
          Effect.annotateLogs({ requestId: "synthetic-request" }),
          Effect.exit,
          Effect.provide(Logger.layer([logger]))
        )
      )
      expect(result._tag).toBe("Failure")
    }
    expect(JSON.stringify(captured)).not.toContain("PRIVATE_SENTINEL")
    expect(captured).toEqual(
      reasons.map((reason, index) => ({
        message: [
          {
            event: "database_failure",
            category: ["connection_acquisition", "statement_timeout", "lock_timeout", "other_sql_failure"][index],
            reason: reason._tag
          }
        ],
        annotations: { requestId: "synthetic-request" }
      }))
    )
  })
})
