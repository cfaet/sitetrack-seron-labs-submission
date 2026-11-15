import { randomUUID } from "node:crypto"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { Actor, ProjectInput, ProjectPatch, ProjectQuery } from "../domain/models.js"
import { conflict, invalid, notFound } from "../domain/errors.js"
import { CompanyTime } from "../config/company.js"
import { readProjects } from "../repositories/projects.js"
import { Database, execute, rows } from "../repositories/database.js"
import { Auth } from "./auth.js"
import { projectTransaction } from "./access.js"
const makeProjects = Effect.gen(function* () {
  const sql = yield* Database,
    auth = yield* Auth,
    clock = yield* CompanyTime
  const bind = <A, E>(effect: Effect.Effect<A, E, Database | Auth>) =>
    effect.pipe(Effect.provideService(Database, sql), Effect.provideService(Auth, auth))
  const get = Effect.fn("Projects.get")(
    function* (actor: Actor, id: string) {
      const now = yield* clock.now,
        result = yield* readProjects(actor, {}, now.today, id)
      const project = result.items[0]
      if (!project) return yield* notFound()
      return project
    },
    execute,
    bind
  )
  const list = Effect.fn("Projects.list")(
    function* (actor: Actor, query: typeof ProjectQuery.Type) {
      const now = yield* clock.now
      return yield* readProjects(actor, query, now.today)
    },
    execute,
    bind
  )
  const create = Effect.fn("Projects.create")(
    function* (actor: Actor, input: typeof ProjectInput.Type) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* auth.lockActor(actor)
          const id = randomUUID()
          const inserted = yield* rows(
            Schema.Struct({ id: Schema.String }),
            sql`INSERT INTO projects(id,name,start_date,end_date) VALUES (${id},${input.name},${input.startDate},${input.endDate}) RETURNING public_id AS id`
          )
          const created = inserted[0]
          if (!created) return yield* Effect.die(new Error("Project insert returned no row"))
          yield* sql`INSERT INTO memberships(project_id,user_id,is_admin) VALUES (${id},${actor.user.id},true)`
          yield* sql`INSERT INTO stores(id,project_id) VALUES (${randomUUID()},${id})`
          return yield* get(actor, created.id)
        })
      )
    },
    execute,
    bind
  )
  const update = Effect.fn("Projects.update")(
    (actor: Actor, id: string, input: typeof ProjectPatch.Type) =>
      projectTransaction(actor, id, true, (project, current) =>
        Effect.gen(function* () {
          const name = input.name ?? project.name,
            start = input.startDate ?? project.startDate,
            end = input.endDate ?? project.endDate
          if (start > end) return yield* invalid()
          yield* sql`UPDATE projects SET name=${name},start_date=${start},end_date=${end} WHERE id=${project.internalId}`
          return yield* get(current, id)
        })
      ),
    execute,
    bind
  )
  const remove = Effect.fn("Projects.remove")(
    (actor: Actor, id: string) =>
      projectTransaction(actor, id, true, (project) =>
        Effect.gen(function* () {
          const occupied = yield* rows(
            Schema.Struct({ occupied: Schema.Boolean }),
            sql`SELECT
            EXISTS(SELECT 1 FROM stock_balances b JOIN stores s ON s.id=b.store_id WHERE s.project_id=${project.internalId} AND b.quantity>0)
            OR EXISTS(SELECT 1 FROM deliveries WHERE project_id=${project.internalId} AND status='InTransit') AS occupied`
          )
          if (occupied[0]?.occupied)
            return yield* conflict("PROJECT_NOT_EMPTY", "The project still has stock or in-transit deliveries.")
          const now = new Date(yield* Clock.currentTimeMillis).toISOString()
          yield* sql`UPDATE projects SET deleted_at=${now} WHERE id=${project.internalId}`
          yield* sql`UPDATE invitations SET status='Withdrawn' WHERE project_id=${project.internalId} AND status='Pending'`
        })
      ),
    execute,
    bind
  )
  return { get, list, create, update, remove }
})
export class Projects extends Context.Service<Projects, Effect.Success<typeof makeProjects>>()("sitetrack/Projects") {
  static readonly layer = Layer.effect(Projects, makeProjects)
}
