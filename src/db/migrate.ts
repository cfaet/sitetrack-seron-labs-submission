import { NodeServices } from "@effect/platform-node"
import { PgMigrator } from "@effect/sql-pg"
import { Effect } from "effect"
import { Migrator, SqlClient } from "effect/sql"
import type { AppConfig } from "../config/config.js"
import { queryProbe } from "./database.js"
import { databaseStartup } from "./startup.js"
import projectNumber from "./migrations/0001_project_number.js"
import identity from "./migrations/0002_identity.js"
import projects from "./migrations/0003_projects.js"
import invitations from "./migrations/0004_invitations.js"
import tasks from "./migrations/0005_tasks.js"
import inventory from "./migrations/0006_inventory.js"
import seedRuns from "./migrations/0007_seed_runs.js"

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
      // Transaction-local: pooled request connections return to their five-second limit.
      yield* sql`SET LOCAL statement_timeout = '30s'`
      yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sitetrack:migrations:${config.schema}`}, 0))`
      yield* sql`CREATE SCHEMA IF NOT EXISTS ${sql(config.schema)}`
      yield* PgMigrator.run({ loader }).pipe(Effect.provide(NodeServices.layer))
    })
  )
})

export const initializeDatabase = Effect.fn("initializeDatabase")(
  (config: AppConfig, loader: Migrator.Loader = migrations) => databaseStartup(queryProbe, migrate(config, loader))
)
