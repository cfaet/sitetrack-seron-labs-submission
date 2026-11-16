import { describe, expect, it } from "vitest"
import { Data, Deferred, Effect, Fiber, Schema } from "effect"
import { Migrator, SqlClient } from "effect/sql"
import { databaseLayer } from "../../src/db/database.js"
import { initializeDatabase, migrate } from "../../src/db/migrate.js"
import { inspectDatabase } from "../../src/db/inspect.js"
import projectNumber from "../../src/db/migrations/0001_project_number.js"
import identity from "../../src/db/migrations/0002_identity.js"
import projects from "../../src/db/migrations/0003_projects.js"
import invitations from "../../src/db/migrations/0004_invitations.js"
import tasks from "../../src/db/migrations/0005_tasks.js"
import { withTestDatabase } from "./database-fixture.js"

class BrokenMigration extends Data.TaggedError("BrokenMigration")<{ readonly message: string }> {}

describe("PostgreSQL migrations (BOOT-02)", () => {
  it("applies once and preserves issued numbers through new pools", async () => {
    await Effect.runPromise(
      withTestDatabase((config) =>
        Effect.gen(function* () {
          yield* initializeDatabase(config)
          const sql = yield* SqlClient.SqlClient
          const first = yield* sql`SELECT nextval('project_number_seq')::text AS number`
          expect(first).toEqual([{ number: "1" }])
          yield* initializeDatabase(config).pipe(Effect.provide(databaseLayer(config)))
          const second = yield* sql`SELECT nextval('project_number_seq')::text AS number`
          expect(second).toEqual([{ number: "2" }])
          expect((yield* inspectDatabase(config)).migrations).toEqual([
            { migration_id: 1, name: "project_number" },
            { migration_id: 2, name: "identity" },
            { migration_id: 3, name: "projects" },
            { migration_id: 4, name: "invitations" },
            { migration_id: 5, name: "tasks" },
            { migration_id: 6, name: "inventory" },
            { migration_id: 7, name: "seed_runs" }
          ])
        })
      )
    )
  })

  it("upgrades a retained Stage 1 ledger without resetting issued identifiers", async () => {
    await Effect.runPromise(
      withTestDatabase((config) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* migrate(config, Migrator.fromRecord({ "0001_project_number": projectNumber }))
          expect(yield* sql`SELECT nextval('project_number_seq')::text AS number`).toEqual([{ number: "1" }])
          yield* initializeDatabase(config)
          expect((yield* inspectDatabase(config)).migrations.map((entry) => entry.migration_id)).toEqual([
            1, 2, 3, 4, 5, 6, 7
          ])
          expect(yield* sql`SELECT nextval('project_number_seq')::text AS number`).toEqual([{ number: "2" }])
          expect(yield* sql`SELECT count(*)::int AS count FROM stores WHERE project_id IS NULL`).toEqual([{ count: 1 }])
        })
      )
    )
  })

  it("upgrades retained Stage 2 project data without resetting counters or memberships", async () => {
    await Effect.runPromise(
      withTestDatabase((config) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* migrate(
            config,
            Migrator.fromRecord({
              "0001_project_number": projectNumber,
              "0002_identity": identity,
              "0003_projects": projects,
              "0004_invitations": invitations
            })
          )
          yield* sql`INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES ('00000000-0000-4000-8000-000000000010','Retained','retained@example.test','fixture-only','User','2026-11-14T00:00:00Z')`
          yield* sql`INSERT INTO projects(id,name,start_date,end_date,task_counter) VALUES ('00000000-0000-4000-8000-000000000020','Retained','2026-01-01','2026-12-31',27)`
          yield* sql`INSERT INTO memberships(project_id,user_id,is_admin) VALUES ('00000000-0000-4000-8000-000000000020','00000000-0000-4000-8000-000000000010',true)`
          yield* initializeDatabase(config)
          expect(yield* sql`SELECT public_id,task_counter::text AS counter FROM projects`).toEqual([
            { public_id: "PRJ-0001", counter: "27" }
          ])
          expect(yield* sql`SELECT count(*)::int AS count FROM memberships WHERE is_admin`).toEqual([{ count: 1 }])
          expect(yield* sql`SELECT count(*)::int AS count FROM tasks`).toEqual([{ count: 0 }])
          expect(yield* sql`SELECT nextval('project_number_seq')::text AS number`).toEqual([{ number: "2" }])
        })
      )
    )
  })

  it("upgrades retained Stage 3 tasks and stores without altering identifiers or counters", async () => {
    await Effect.runPromise(
      withTestDatabase((config) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* migrate(
            config,
            Migrator.fromRecord({
              "0001_project_number": projectNumber,
              "0002_identity": identity,
              "0003_projects": projects,
              "0004_invitations": invitations,
              "0005_tasks": tasks
            })
          )
          yield* sql`INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES ('00000000-0000-4000-8000-000000000010','Retained','retained@example.test','fixture-only','User','2026-11-14T00:00:00Z')`
          yield* sql`INSERT INTO projects(id,name,start_date,end_date,task_counter) VALUES ('00000000-0000-4000-8000-000000000020','Retained','2026-01-01','2026-12-31',7)`
          yield* sql`INSERT INTO memberships(project_id,user_id,is_admin) VALUES ('00000000-0000-4000-8000-000000000020','00000000-0000-4000-8000-000000000010',true)`
          yield* sql`INSERT INTO stores(id,project_id) VALUES ('00000000-0000-4000-8000-000000000030','00000000-0000-4000-8000-000000000020')`
          yield* sql`INSERT INTO tasks(id,project_id,task_number,public_id,name,start_date,end_date) VALUES ('00000000-0000-4000-8000-000000000040','00000000-0000-4000-8000-000000000020',7,'PRJ-0001-T-0007','Retained task','2026-01-01','2026-12-31')`
          yield* initializeDatabase(config)
          yield* initializeDatabase(config)
          expect(yield* sql`SELECT public_id AS id,task_counter::text AS counter FROM projects`).toEqual([
            { id: "PRJ-0001", counter: "7" }
          ])
          expect(yield* sql`SELECT public_id AS id,name FROM tasks`).toEqual([
            { id: "PRJ-0001-T-0007", name: "Retained task" }
          ])
          expect(yield* sql`SELECT count(*)::int AS count FROM stores`).toEqual([{ count: 2 }])
          expect(yield* sql`SELECT count(*)::int AS count FROM memberships WHERE is_admin`).toEqual([{ count: 1 }])
          expect(yield* sql`SELECT count(*)::int AS count FROM stock_balances`).toEqual([{ count: 0 }])
          expect((yield* inspectDatabase(config)).migrations.map((entry) => entry.migration_id)).toEqual([
            1, 2, 3, 4, 5, 6, 7
          ])
          expect(yield* sql`SELECT nextval('project_number_seq')::text AS number`).toEqual([{ number: "2" }])
        })
      )
    )
  })
  it("serializes overlapping migration runners on separate connections", async () => {
    await Effect.runPromise(
      withTestDatabase((config) =>
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          let executions = 0
          const loader = Migrator.fromRecord({
            "0001_overlap": Effect.gen(function* () {
              executions++
              const sql = yield* SqlClient.SqlClient
              yield* sql`CREATE TABLE overlap_probe (id integer PRIMARY KEY)`
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
            })
          })
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
        })
      )
    )
  })

  it("rolls back failed DDL and the migration record", async () => {
    await Effect.runPromise(
      withTestDatabase((config) =>
        Effect.gen(function* () {
          const loader = Migrator.fromRecord({
            "0001_broken": Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              yield* sql`CREATE TABLE rollback_probe (id integer)`
              return yield* new BrokenMigration({ message: "deliberately broken migration" })
            })
          })
          const failure = yield* initializeDatabase(config, loader).pipe(Effect.flip)
          expect(failure._tag).toBe("StartupError")
          const sql = yield* SqlClient.SqlClient
          const rows = yield* Schema.decodeUnknownEffect(
            Schema.Array(Schema.Struct({ name: Schema.NullOr(Schema.String) }))
          )(yield* sql`SELECT to_regclass(${`${config.schema}.rollback_probe`})::text AS name`)
          expect(rows).toEqual([{ name: null }])
          expect((yield* inspectDatabase(config)).migrations).toEqual([])
          yield* initializeDatabase(config)
        })
      )
    )
  })
})
