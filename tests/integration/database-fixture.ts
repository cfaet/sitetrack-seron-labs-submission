import { randomUUID } from "node:crypto"
import { PgClient } from "@effect/sql-pg"
import { Effect, Schema, type Scope } from "effect"
import { SqlClient } from "effect/sql"
import { ConfigurationError, readTestConfig, type AppConfig } from "../../src/config/config.js"
import { databaseLayer } from "../../src/db/database.js"
import { assertTestDatabase } from "../../src/db/inspect.js"

const Oids = Schema.Array(Schema.Struct({ oid: Schema.String }))

// Test configuration is checked before connecting, and identity before any DDL.
// Cleanup is scoped to a schema this run created and whose OID still matches.
export const withTestDatabase = <A, E>(
  run: (config: AppConfig) => Effect.Effect<A, E, SqlClient.SqlClient | PgClient.PgClient | Scope.Scope>
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const base = yield* readTestConfig(process.env)
      return yield* Effect.scoped(
        Effect.gen(function* () {
          yield* assertTestDatabase
          const sql = yield* SqlClient.SqlClient
          const schema = `sitetrack_test_${randomUUID().replaceAll("-", "")}`
          const oidQuery = Schema.decodeUnknownEffect(Oids)
          yield* Effect.acquireRelease(
            Effect.gen(function* () {
              yield* sql`CREATE SCHEMA ${sql(schema)}`
              const rows = yield* oidQuery(
                yield* sql`SELECT oid::text AS oid FROM pg_namespace WHERE nspname = ${schema}`
              )
              const oid = rows[0]?.oid
              if (oid === undefined)
                return yield* new ConfigurationError({ message: "Could not identify test-owned schema." })
              return oid
            }),
            (oid) =>
              Effect.gen(function* () {
                yield* assertTestDatabase
                const rows = yield* oidQuery(
                  yield* sql`SELECT oid::text AS oid FROM pg_namespace WHERE nspname = ${schema}`
                )
                if (rows[0]?.oid !== oid)
                  return yield* new ConfigurationError({ message: "Refusing cleanup: test schema identity changed." })
                yield* sql`DROP SCHEMA ${sql(schema)} CASCADE`
              }).pipe(Effect.orDie)
          )
          const config = Object.freeze({ ...base, schema, host: "127.0.0.1", port: 0 })
          return yield* Effect.scoped(run(config)).pipe(Effect.provide(databaseLayer(config)))
        })
      ).pipe(Effect.provide(databaseLayer(base)))
    })
  )
