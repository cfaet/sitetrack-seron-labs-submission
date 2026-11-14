import { NodeServices } from "@effect/platform-node"
import { PgMigrator } from "@effect/sql-pg"
import { Data, Effect, Schedule } from "effect"
import { Migrator, SqlClient, SqlError } from "effect/sql"
import type { AppConfig } from "../config/config.js"
import { queryProbe } from "./database.js"
import projectNumber from "./migrations/0001_project_number.js"

export class StartupError extends Data.TaggedError("StartupError")<{
  readonly message: string
}> {}

export const migrations = Migrator.fromRecord({ "0001_project_number": projectNumber })

export const migrate = Effect.fn("migrate")(function*(config: AppConfig, loader: Migrator.Loader = migrations) {
  const sql = yield* SqlClient.SqlClient
  // Cross-process serialization also covers initial schema/ledger creation.
  yield* sql.withTransaction(Effect.gen(function*() {
    yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sitetrack:migrations:${config.schema}`}, 0))`
    yield* sql`CREATE SCHEMA IF NOT EXISTS ${sql(config.schema)}`
    yield* PgMigrator.run({ loader }).pipe(Effect.provide(NodeServices.layer))
  }))
})

export const initializeDatabase = Effect.fn("initializeDatabase")(
  (config: AppConfig, loader: Migrator.Loader = migrations) => Effect.gen(function*() {
    // Retry only availability probes. Migrations execute once, transactionally.
    yield* queryProbe.pipe(Effect.retry({
      schedule: Schedule.spaced("250 millis"),
      while: (error) => SqlError.isSqlError(error) && error.isRetryable
    }))
    yield* migrate(config, loader)
  }).pipe(
    Effect.timeout("30 seconds"),
    Effect.mapError(() => new StartupError({ message: "Database startup failed or exceeded 30 seconds." }))
  )
)
