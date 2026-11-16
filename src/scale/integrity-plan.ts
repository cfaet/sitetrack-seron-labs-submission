import { Data, Effect, Schema } from "effect"
import { SqlClient, SqlError } from "effect/sql"
import { rows } from "../repositories/database.js"
import { IntegrityPlanMode, type Profile } from "./profile.js"
import { movementIntegrityQuery, verifySeedManifest } from "./seed.js"

export class IntegrityPlanFailed extends Data.TaggedError("IntegrityPlanFailed")<{
  readonly message: string
}> {}

export const integrityPlan = Effect.fn("scale.integrityPlan")(function* (
  profile: Profile,
  mode: typeof IntegrityPlanMode.Type
) {
  yield* verifySeedManifest(profile)
  const sql = yield* SqlClient.SqlClient
  const [text, parameters] = movementIntegrityQuery(sql).compile()
  const explain = (analyze: boolean) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SET TRANSACTION READ ONLY`
        // The shared builder emits only this fixed SELECT; callers cannot supply SQL.
        return yield* rows(
          Schema.Struct({ "QUERY PLAN": Schema.Array(Schema.Unknown) }),
          sql.unsafe(`EXPLAIN (${analyze ? "ANALYZE, BUFFERS, " : ""}FORMAT JSON) ${text}`, parameters)
        )
      })
    )
  const estimated = yield* explain(false)
  yield* Effect.sync(() =>
    process.stderr.write(
      JSON.stringify({ event: "integrity_plan_estimated", query: "movement phases, quantities and destinations" }) +
        "\n"
    )
  )
  if (mode === "estimate") return { mode, passed: true, analyzed: false, estimated, actual: null, failure: null }
  const actual = yield* explain(true).pipe(
    Effect.map((plan) => ({ plan, failure: null })),
    Effect.catchIf(SqlError.isSqlError, (error) => Effect.succeed({ plan: null, failure: error.reason._tag }))
  )
  return {
    mode,
    passed: actual.failure === null,
    analyzed: actual.failure === null,
    estimated,
    actual: actual.plan,
    failure: actual.failure
  }
})
