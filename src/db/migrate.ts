import { NodeServices } from "@effect/platform-node"
import { PgMigrator } from "@effect/sql-pg"
import { Data, Effect, Schedule } from "effect"
import { Migrator, SqlClient, SqlError } from "effect/sql"
import type { AppConfig } from "../config/config.js"
import { queryProbe } from "./database.js"
import projectNumber from "./migrations/0001_project_number.js"
import identity from "./migrations/0002_identity.js"
import projects from "./migrations/0003_projects.js"
import invitations from "./migrations/0004_invitations.js"
import tasks from "./migrations/0005_tasks.js"
import inventory from "./migrations/0006_inventory.js"
import seedRuns from "./migrations/0007_seed_runs.js"

export class StartupError extends Data.TaggedError("StartupError")<{
  readonly message: string
}> {}

export const migrations = Migrator.fromRecord({
  "0001_project_number": projectNumber,
  "0002_identity": identity,
  "0003_projects": projects,
  "0004_invitations": invitations,
  "0005_tasks": tasks,
  "0006_inventory": inventory,
  "0007_seed_runs": seedRuns
})

export const migrate = Effect.fn("migrate")(function* (config: AppConfig, loader: Migrator.Loader = migrations) {
  const sql = yield* SqlClient.SqlClient
  // Cross-process serialization also covers initial schema/ledger creation.
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sitetrack:migrations:${config.schema}`}, 0))`
      yield* sql`CREATE SCHEMA IF NOT EXISTS ${sql(config.schema)}`
      yield* PgMigrator.run({ loader }).pipe(Effect.provide(NodeServices.layer))
    })
  )
})

export const initializeDatabase = Effect.fn("initializeDatabase")(
  (config: AppConfig, loader: Migrator.Loader = migrations) =>
    Effect.gen(function* () {
      // Retry only availability probes. Migrations execute once, transactionally.
      yield* queryProbe.pipe(
        Effect.retry({
          schedule: Schedule.spaced("250 millis"),
          while: (error) => SqlError.isSqlError(error) && error.isRetryable
        })
      )
      yield* migrate(config, loader)
    }).pipe(
      Effect.timeout("30 seconds"),
      Effect.mapError(() => new StartupError({ message: "Database startup failed or exceeded 30 seconds." }))
    )
)
