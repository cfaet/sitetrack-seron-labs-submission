import { Data, Effect, Schema } from "effect"
import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { initializeDatabase } from "../../src/db/migrate.js"
import { checkSeed, loadSeed, scaleLock, movementIntegrityQuery } from "../../src/scale/seed.js"
import { integrityPlan } from "../../src/scale/integrity-plan.js"
import * as Model from "../../src/domain/models.js"
import * as TaskModel from "../../src/domain/task-models.js"
import { withApp } from "./app-fixture.js"
import { profiles, demoPassword } from "../../src/scale/profile.js"
import { Passwords } from "../../src/services/security.js"
import { SqlClient } from "effect/sql"
import { PgClient } from "@effect/sql-pg"
import { withTestDatabase, withTestMaintenance } from "./database-fixture.js"
import { rows } from "../../src/repositories/database.js"

class FixtureRollback extends Data.TaggedError("FixtureRollback") {}

describe("seed safety and invariants (SCALE-01)", () => {
  it("checks every movement rule and includes violations beyond a delivery-range boundary", async () => {
    await Effect.runPromise(
      withTestDatabase((config) =>
        Effect.gen(function* () {
          yield* initializeDatabase(config)
          yield* loadSeed("small", true).pipe(withTestMaintenance)
          const sql = yield* SqlClient.SqlClient
          const count = () =>
            rows(Schema.Struct({ count: Schema.Int }), movementIntegrityQuery(sql)).pipe(
              Effect.map((found) => found[0]?.count),
              withTestMaintenance
            )
          const selected = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.String })))(
            yield* sql`SELECT a.id::text AS id FROM stock_movements a JOIN deliveries d ON d.id=a.delivery_id
          WHERE d.direction='CompanyToProject' AND d.status='Delivered' AND a.phase='Dispatch' ORDER BY a.id LIMIT 1`
          )
          const dispatch = selected[0]?.id
          if (dispatch === undefined) throw new Error("Missing seeded dispatch")
          const terminal = (yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.String })))(
            yield* sql`SELECT b.id::text AS id FROM stock_movements b JOIN stock_movements a ON a.delivery_id=b.delivery_id AND a.material_id=b.material_id
          WHERE a.id=${dispatch} AND b.phase='Terminal'`
          ))[0]?.id
          if (terminal === undefined) throw new Error("Missing seeded receipt")
          const corruptions = [
            sql`DELETE FROM stock_movements WHERE id=${dispatch}`,
            sql`UPDATE stock_movements SET delta=delta-1 WHERE id=${dispatch}`,
            sql`UPDATE stock_movements a SET store_id=s.id FROM deliveries d JOIN stores s ON s.project_id=d.project_id WHERE a.id=${dispatch} AND d.id=a.delivery_id`,
            sql`DELETE FROM stock_movements WHERE id=${terminal}`,
            sql`UPDATE stock_movements SET delta=delta+1 WHERE id=${terminal}`,
            sql`UPDATE stock_movements SET kind='RejectionRefund' WHERE id=${terminal}`,
            sql`UPDATE stock_movements SET store_id='00000000-0000-4000-8000-000000000001' WHERE id=${terminal}`,
            sql`INSERT INTO stock_movements(id,store_id,material_id,delta,kind,delivery_id,phase,actor_id,created_at)
          SELECT ${randomUUID()},a.store_id,a.material_id,-a.delta,'Receipt',a.delivery_id,'Terminal',a.actor_id,a.created_at
          FROM stock_movements a JOIN deliveries d ON d.id=a.delivery_id WHERE d.status='InTransit' AND a.phase='Dispatch' ORDER BY a.id LIMIT 1`,
            sql`UPDATE stock_movements SET kind='Receipt' WHERE id=(SELECT a.id FROM stock_movements a JOIN deliveries d ON d.id=a.delivery_id WHERE d.status='Cancelled' AND a.phase='Terminal' ORDER BY a.id LIMIT 1)`,
            sql`UPDATE stock_movements SET store_id='00000000-0000-4000-8000-000000000001' WHERE id=(SELECT a.id FROM stock_movements a JOIN deliveries d ON d.id=a.delivery_id WHERE d.direction='ProjectToCompany' AND a.phase='Dispatch' ORDER BY a.id LIMIT 1)`,
            sql`UPDATE stock_movements a SET store_id=s.id FROM deliveries d JOIN stores s ON s.project_id=d.project_id WHERE a.id=(SELECT b.id FROM stock_movements b JOIN deliveries e ON e.id=b.delivery_id WHERE e.direction='ProjectToCompany' AND e.status='Delivered' AND b.phase='Terminal' ORDER BY b.id LIMIT 1) AND d.id=a.delivery_id`
          ]
          expect(yield* count()).toBe(0)
          for (const corruption of corruptions) {
            yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* corruption
                  expect(yield* count()).toBe(1)
                  return yield* new FixtureRollback()
                })
              )
              .pipe(
                Effect.catchIf(
                  (error) => error instanceof FixtureRollback,
                  () => Effect.void
                )
              )
            expect(yield* count()).toBe(0)
          }
          // Add valid dispatches past the 2,000-delivery boundary, then damage its last line.
          yield* sql`INSERT INTO deliveries(id,project_id,direction,status,initiated_at,initiated_by)
        SELECT ('f0000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,
          '20000000-0000-4000-8000-000000000001','CompanyToProject','InTransit',now(),'10000000-0000-4000-8000-000000000002'
        FROM generate_series(1,1002) i`
          yield* sql`INSERT INTO delivery_lines(delivery_id,material_id,material_name,unit,quantity)
        SELECT d.id,l.material_id,l.material_name,l.unit,l.quantity FROM deliveries d
        CROSS JOIN LATERAL (SELECT * FROM delivery_lines WHERE delivery_id='80000000-0000-4000-8000-000000000001' ORDER BY material_id LIMIT 1) l
        WHERE d.id>='f0000000-0000-4000-8000-000000000001'`
          yield* sql`INSERT INTO stock_movements(id,store_id,material_id,delta,kind,delivery_id,phase,actor_id,created_at)
        SELECT gen_random_uuid(),'00000000-0000-4000-8000-000000000001',l.material_id,-l.quantity,'Dispatch',l.delivery_id,'Dispatch','10000000-0000-4000-8000-000000000002',now()
        FROM delivery_lines l WHERE l.delivery_id>='f0000000-0000-4000-8000-000000000001'`
          expect(yield* count()).toBe(0)
          yield* sql`UPDATE stock_movements SET delta=delta-1 WHERE id=${dispatch} OR delivery_id='f0000000-0000-4000-8000-000000001002'`
          expect(yield* count()).toBe(2)
        }).pipe(Effect.provide(Passwords.layer))
      )
    )
  }, 180000)
  it("guards direct inventory plans and preserves full validation of malformed movements", async () => {
    await Effect.runPromise(
      withTestDatabase((config) =>
        Effect.gen(function* () {
          yield* initializeDatabase(config)
          expect(yield* Effect.exit(integrityPlan("small", "estimate"))).toMatchObject({ _tag: "Failure" })
          yield* loadSeed("small", true).pipe(withTestMaintenance)
          expect(yield* Effect.exit(integrityPlan("large", "estimate"))).toMatchObject({ _tag: "Failure" })
          const estimate = yield* integrityPlan("small", "estimate")
          expect(estimate).toMatchObject({ passed: true, analyzed: false, actual: null })
          expect(estimate.estimated).toHaveLength(1)
          const analyzed = yield* integrityPlan("small", "analyze")
          expect(analyzed).toMatchObject({ passed: true, analyzed: true, failure: null })
          expect(analyzed.actual).toHaveLength(1)
          const sql = yield* SqlClient.SqlClient
          const line = (yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.String })))(
            yield* sql`SELECT id::text AS id FROM stock_movements WHERE phase='Dispatch' ORDER BY id LIMIT 1`
          ))[0]
          if (!line) throw new Error("Seed must contain dispatch history")
          yield* sql`UPDATE stock_movements SET delta=delta-1 WHERE id=${line.id}`
          const violations = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ count: Schema.Int })))(
            yield* movementIntegrityQuery(sql)
          )
          expect(violations[0]?.count).toBe(1)
          expect(yield* Effect.exit(checkSeed("small").pipe(withTestMaintenance))).toMatchObject({ _tag: "Failure" })
        }).pipe(Effect.provide(Passwords.layer))
      )
    )
  })
  it("loads exact small counts, reuses completed data and refuses incompatible or malformed data", async () => {
    await Effect.runPromise(
      withTestDatabase((config) =>
        Effect.gen(function* () {
          yield* initializeDatabase(config)
          expect(yield* loadSeed("small", true).pipe(withTestMaintenance)).toEqual(profiles.small)
          expect(yield* loadSeed("small", true).pipe(withTestMaintenance)).toEqual(profiles.small)
          expect(yield* Effect.exit(loadSeed("large", true))).toMatchObject({ _tag: "Failure" })
          const sql = yield* SqlClient.SqlClient
          yield* sql`UPDATE seed_runs SET counts=jsonb_set(counts,'{tasks}','0'::jsonb)`
          expect(yield* Effect.exit(checkSeed("small").pipe(withTestMaintenance))).toMatchObject({ _tag: "Failure" })
          yield* sql`UPDATE seed_runs SET counts=${JSON.stringify(profiles.small)}::jsonb`
          yield* sql`UPDATE stock_balances SET quantity=quantity+1 WHERE store_id='00000000-0000-4000-8000-000000000001'`
          expect(yield* Effect.exit(checkSeed("small").pipe(withTestMaintenance))).toMatchObject({ _tag: "Failure" })
        }).pipe(Effect.provide(Passwords.layer))
      )
    )
  })
  it("refuses unapproved, occupied and interrupted datasets", async () => {
    await Effect.runPromise(
      withTestDatabase((config) =>
        Effect.gen(function* () {
          yield* initializeDatabase(config)
          const sql = yield* SqlClient.SqlClient
          expect(yield* Effect.exit(loadSeed("small", false))).toMatchObject({ _tag: "Failure" })
          yield* sql`INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES ('10000000-0000-4000-8000-000000000001','Existing','existing@example.test','fixture','User',now())`
          expect(yield* Effect.exit(loadSeed("small", true))).toMatchObject({ _tag: "Failure" })
          // Simulate a retained interrupted run without deleting any existing rows.
          yield* sql`INSERT INTO seed_runs(profile,generator_version,random_seed,reference_date,state) VALUES ('small',1,42,'2026-11-01','loading')`
          expect(yield* Effect.exit(loadSeed("small", true))).toMatchObject({ _tag: "Failure" })
        }).pipe(Effect.provide(Passwords.layer))
      )
    )
  })
  it("refuses a second operation while another connection holds the dataset lock", async () => {
    await Effect.runPromise(
      withTestDatabase((config) =>
        Effect.gen(function* () {
          yield* initializeDatabase(config)
          const sql = yield* SqlClient.SqlClient
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(current_database()||':'||current_schema()||':scale',0))`
              const other = PgClient.layerFrom(
                PgClient.makeClient({ url: config.databaseUrl, startupParameters: { search_path: config.schema } })
              )
              const result = yield* scaleLock(Effect.succeed("unexpected")).pipe(Effect.provide(other), Effect.exit)
              expect(result).toMatchObject({ _tag: "Failure" })
            })
          )
        })
      )
    )
  })
})

it("serves seeded demo accounts and allocates project/task IDs beyond seeded counters", async () => {
  await Effect.runPromise(
    withApp(async ({ request, sql }) => {
      await Effect.runPromise(
        loadSeed("small", true).pipe(
          withTestMaintenance,
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provide(Passwords.layer)
        )
      )
      const response = await request("POST", "/api/v1/auth/login", {
        email: "user3@sitetrack.example",
        password: demoPassword
      })
      expect(response.status).toBe(200)
      const session = Schema.decodeUnknownSync(Model.SessionResult)(await response.json())
      const client = { token: session.accessToken }
      const input = { name: "After seed", startDate: "2026-01-01", endDate: "2027-01-01" }
      const created = await request("POST", "/api/v1/projects", input, client)
      expect(created.status).toBe(201)
      expect(Schema.decodeUnknownSync(Model.Project)(await created.json()).id).toBe("PRJ-0021")
      const task = await request("POST", "/api/v1/projects/PRJ-0001/tasks", input, client)
      expect(task.status).toBe(201)
      expect(Schema.decodeUnknownSync(TaskModel.TaskDetail)(await task.json()).id).toBe("PRJ-0001-T-0301")
    })
  )
}, 180000)
