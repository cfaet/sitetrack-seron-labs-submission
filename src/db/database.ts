import { PgClient } from "@effect/sql-pg"
import { Data, Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { AppConfig } from "../config/config.js"

export class DatabaseUnavailable extends Data.TaggedError("DatabaseUnavailable") {}

export const databaseLayer = (config: AppConfig) => PgClient.layer({
  url: config.databaseUrl,
  applicationName: `sitetrack:${config.schema}`,
  maxConnections: 5,
  minConnections: 0,
  connectTimeout: "3 seconds",
  acquireTimeout: "2 seconds",
  idleTimeout: "30 seconds",
  // Never inherit a URL-supplied search path. Tests use a schema owned by their run.
  startupParameters: { search_path: config.schema, statement_timeout: "5000", lock_timeout: "5000" }
})

const Probe = Schema.Array(Schema.Struct({ ok: Schema.Literal(1) }))

export const queryProbe = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT 1::int AS ok`
  const decoded = yield* Schema.decodeUnknownEffect(Probe)(rows)
  if (decoded.length !== 1) return yield* new DatabaseUnavailable()
})

export const probeDatabase = queryProbe.pipe(Effect.mapError(() => new DatabaseUnavailable()))
