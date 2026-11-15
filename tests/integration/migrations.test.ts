import { describe, expect, it } from "vitest"
import { Deferred, Effect, Fiber, Schema } from "effect"
import { Migrator, SqlClient } from "effect/sql"
import { databaseLayer } from "../../src/db/database.js"
import { initializeDatabase, migrate } from "../../src/db/migrate.js"
import { inspectDatabase } from "../../src/db/inspect.js"
import projectNumber from "../../src/db/migrations/0001_project_number.js"
import { withTestDatabase } from "./database-fixture.js"

describe("PostgreSQL migrations (BOOT-02)", () => {
  it("applies once and preserves issued numbers through new pools", async () => {
    await Effect.runPromise(withTestDatabase((config) => Effect.gen(function*() {
      yield* initializeDatabase(config)
      const sql = yield* SqlClient.SqlClient
      const first = yield* sql`SELECT nextval('project_number_seq')::text AS number`
      expect(first).toEqual([{ number: "1" }])
      yield* initializeDatabase(config).pipe(Effect.provide(databaseLayer(config)))
      const second = yield* sql`SELECT nextval('project_number_seq')::text AS number`
      expect(second).toEqual([{ number: "2" }])
      expect((yield* inspectDatabase(config)).migrations).toEqual([{ migration_id: 1, name: "project_number" }, { migration_id: 2, name: "identity" }, { migration_id: 3, name: "projects" }, { migration_id: 4, name: "invitations" }])
    })))
  })

  it("upgrades a retained Stage 1 ledger without resetting issued identifiers", async () => {
    await Effect.runPromise(withTestDatabase((config) => Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* migrate(config, Migrator.fromRecord({ "0001_project_number": projectNumber }))
      expect(yield* sql`SELECT nextval('project_number_seq')::text AS number`).toEqual([{ number: "1" }])
      yield* initializeDatabase(config)
      expect((yield* inspectDatabase(config)).migrations.map((entry) => entry.migration_id)).toEqual([1,2,3,4])
      expect(yield* sql`SELECT nextval('project_number_seq')::text AS number`).toEqual([{ number: "2" }])
      expect(yield* sql`SELECT count(*)::int AS count FROM stores WHERE project_id IS NULL`).toEqual([{ count: 1 }])
    })))
  })

  it("serializes overlapping migration runners on separate connections", async () => {
    await Effect.runPromise(withTestDatabase((config) => Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let executions = 0
      const loader = Migrator.fromRecord({ "0001_overlap": Effect.gen(function*() {
        executions++
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE TABLE overlap_probe (id integer PRIMARY KEY)`
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(release)
      }) })
      const first = yield* migrate(config, loader).pipe(Effect.provide(databaseLayer(config)), Effect.forkScoped)
      yield* Deferred.await(entered)
      const second = yield* migrate(config, loader).pipe(Effect.provide(databaseLayer(config)), Effect.forkScoped)
      yield* Effect.sleep("100 millis")
      expect(executions).toBe(1)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      expect(executions).toBe(1)
      expect((yield* inspectDatabase(config)).migrations).toEqual([{ migration_id: 1, name: "overlap" }])
    })))
  })

  it("rolls back failed DDL and the migration record", async () => {
    await Effect.runPromise(withTestDatabase((config) => Effect.gen(function*() {
      const loader = Migrator.fromRecord({ "0001_broken": Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE TABLE rollback_probe (id integer)`
        return yield* Effect.fail(new Error("deliberately broken migration"))
      }) })
      const failure = yield* initializeDatabase(config, loader).pipe(Effect.flip)
      expect(failure._tag).toBe("StartupError")
      const sql = yield* SqlClient.SqlClient
      const rows = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ name: Schema.NullOr(Schema.String) })))(
        yield* sql`SELECT to_regclass(${`${config.schema}.rollback_probe`})::text AS name`
      )
      expect(rows).toEqual([{ name: null }])
      expect((yield* inspectDatabase(config)).migrations).toEqual([])
      yield* initializeDatabase(config)
    })))
  })
})
