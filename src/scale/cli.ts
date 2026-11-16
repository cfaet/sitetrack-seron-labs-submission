import { PgClient } from "@effect/sql-pg"
import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Logger, Schema } from "effect"
import { SqlClient, SqlError } from "effect/sql"
import { ConfigurationError, readConfig } from "../config/config.js"
import { initializeDatabase } from "../db/migrate.js"
import { StartupError } from "../db/startup.js"
import { rows } from "../repositories/database.js"
import { Passwords } from "../services/security.js"
import { benchmark } from "./benchmark.js"
import { BenchmarkFailed, benchmarkFailureMessage } from "./measurement.js"
import { plans } from "./plans.js"
import { Profile, IntegrityPlanMode } from "./profile.js"
import { integrityPlan, IntegrityPlanFailed } from "./integrity-plan.js"
import { checkSeed, loadSeed, manifest, scaleLock } from "./seed.js"

const main = Effect.gen(function* () {
  const command = process.argv[2]
  const profile = yield* Schema.decodeUnknownEffect(Profile)(process.argv[3] ?? "small")
  if (!["seed", "check", "status", "smoke", "focus", "bench", "plans", "integrity-plan"].includes(command ?? ""))
    return yield* new ConfigurationError({
      message: "Expected seed/check/status/smoke/focus/bench/plans/integrity-plan."
    })
  const planMode = yield* Schema.decodeUnknownEffect(IntegrityPlanMode)(process.argv[4] ?? "estimate").pipe(
    Effect.mapError(() => new ConfigurationError({ message: "Integrity plan mode must be estimate or analyze." }))
  )
  if (command === "seed" && process.env.SITETRACK_SEED_ALLOWED !== "true")
    return yield* new ConfigurationError({
      message: "Seeding requires SITETRACK_SEED_ALLOWED=true before database access."
    })
  const config = yield* readConfig(process.env)
  const layer = PgClient.layerFrom(
    PgClient.makeClient({
      url: config.databaseUrl,
      applicationName: "sitetrack:scale",
      startupParameters: { search_path: config.schema, statement_timeout: "300000", lock_timeout: "5000" }
    })
  )
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const identity = yield* rows(
      Schema.Struct({
        database: Schema.String,
        role: Schema.String,
        fsync: Schema.String,
        sync: Schema.String,
        pages: Schema.String
      }),
      sql`SELECT current_database() AS database,current_user AS role,current_setting('fsync') AS fsync,current_setting('synchronous_commit') AS sync,current_setting('full_page_writes') AS pages`
    )
    const target = identity[0]
    if (!target || target.fsync !== "on" || target.sync !== "on" || target.pages !== "on")
      return yield* new ConfigurationError({ message: "Scale tools require normal PostgreSQL durability." })
    if (command === "seed") yield* initializeDatabase(config)
    const result = yield* command === "status"
      ? manifest
      : scaleLock(
          Effect.gen(function* () {
            if (command === "seed") return yield* loadSeed(profile, process.env.SITETRACK_SEED_ALLOWED === "true")
            if (command === "integrity-plan") return yield* integrityPlan(profile, planMode)
            const verified = yield* checkSeed(profile)
            if (command === "plans") return yield* plans(profile)
            if (command === "bench" || command === "smoke" || command === "focus")
              return yield* benchmark(profile, command)
            return verified
          })
        )
    const dataset = yield* manifest
    const sizes = yield* rows(
      Schema.Struct({ bytes: Schema.String, version: Schema.String }),
      sql`SELECT pg_database_size(current_database())::text AS bytes,version() AS version`
    )
    yield* Effect.sync(() =>
      process.stdout.write(
        JSON.stringify({ command, profile, identity: target, result, dataset: dataset[0], storage: sizes[0] }) + "\n"
      )
    )
    if (typeof result === "object" && result !== null && "passed" in result && result.passed === false) {
      if (command === "integrity-plan")
        return yield* new IntegrityPlanFailed({
          message: "Inventory integrity EXPLAIN ANALYZE failed; estimate and safe failure category were emitted."
        })
      return yield* new BenchmarkFailed({
        message: benchmarkFailureMessage("verdict" in result ? String(result.verdict) : "execution_failed")
      })
    }
  }).pipe(Effect.provide(Layer.mergeAll(layer, Passwords.layer)))
}).pipe(
  Effect.tapError((error) =>
    Effect.sync(() =>
      process.stderr.write(
        JSON.stringify({
          event: "scale_failed",
          kind: error._tag,
          ...(error instanceof StartupError
            ? { phase: error.phase, reason: error.reason }
            : SqlError.isSqlError(error)
              ? { reason: error.reason._tag }
              : {}),
          message:
            error instanceof ConfigurationError ||
            error instanceof BenchmarkFailed ||
            error instanceof IntegrityPlanFailed ||
            error instanceof StartupError
              ? error.message
              : "Scale command failed; inspect the phase and PostgreSQL diagnostics."
        }) + "\n"
      )
    )
  ),
  Effect.provide(Logger.layer([]))
)
NodeRuntime.runMain(main, { disableErrorReporting: true })
