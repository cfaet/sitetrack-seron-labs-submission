import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { AppConfig } from "../config/config.js"
import { ConfigurationError } from "../config/config.js"

const Identity = Schema.Struct({ database: Schema.String, role: Schema.String, version: Schema.String })
const IdentityRows = Schema.Array(Identity)

export const databaseIdentity = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* Schema.decodeUnknownEffect(IdentityRows)(
    yield* sql`
    SELECT current_database() AS database, current_user AS role, current_setting('server_version') AS version
  `
  )
  const row = rows[0]
  if (rows.length !== 1 || row === undefined) {
    return yield* new ConfigurationError({ message: "Could not identify connected database." })
  }
  return row
})

export const assertTestDatabase = databaseIdentity.pipe(
  Effect.flatMap((identity) =>
    identity.database === "sitetrack_test" && identity.role === "sitetrack_test"
      ? Effect.void
      : Effect.fail(
          new ConfigurationError({ message: "Test connection is not the approved sitetrack_test database and role." })
        )
  )
)

export const inspectDatabase = Effect.fn("inspectDatabase")(function* (config: AppConfig) {
  const sql = yield* SqlClient.SqlClient
  const identity = yield* databaseIdentity
  const ledger = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ name: Schema.NullOr(Schema.String) })))(
    yield* sql`SELECT to_regclass(${`${config.schema}.effect_sql_migrations`})::text AS name`
  )
  const MigrationRows = Schema.Array(Schema.Struct({ migration_id: Schema.Int, name: Schema.String }))
  const table = ledger[0]
  if (ledger.length !== 1 || table === undefined) {
    return yield* new ConfigurationError({ message: "Could not inspect migration ledger." })
  }
  const applied =
    table.name === null
      ? []
      : yield* Schema.decodeUnknownEffect(MigrationRows)(
          yield* sql`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`
        )
  return { ...identity, schema: config.schema, migrations: applied }
})
