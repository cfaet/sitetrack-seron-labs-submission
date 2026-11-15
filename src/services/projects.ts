import { randomUUID } from "node:crypto"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { Actor, Project, ProjectInput, ProjectPatch, ProjectQuery } from "../domain/models.js"
import { invalid } from "../domain/errors.js"
import { Database, execute, page, paginated, rows } from "../repositories/database.js"
import { Auth } from "./auth.js"
import { projectAccess, projectTransaction } from "./access.js"
const ListResult = Schema.Struct({ items: Schema.Array(Project), total: Schema.Int })
const makeProjects = Effect.gen(function*() {
  const sql = yield* Database, auth = yield* Auth
  const get = (actor: Actor, id: string) => projectAccess(actor, id).pipe(Effect.map(({ internalId: _, ...project }) => project), execute)
  const list = Effect.fn("Projects.list")(function*(actor: Actor, query: typeof ProjectQuery.Type) {
    const pagination = page(query), search = query.search ?? ""
    const order = query.sort === "startDate" ? sql`p.start_date` : sql`lower(p.name)`
    const direction = query.direction === "desc" ? sql`DESC` : sql`ASC`
    const result = yield* rows(ListResult, sql`WITH visible AS (
      SELECT p.* FROM projects p WHERE p.deleted_at IS NULL AND (${actor.user.role === "SuperAdmin"} OR EXISTS(SELECT 1 FROM memberships m WHERE m.project_id=p.id AND m.user_id=${actor.user.id}))
      AND (strpos(lower(p.name),lower(${search}))>0 OR strpos(lower(p.public_id),lower(${search}))>0)
    ), selected AS (SELECT p.* FROM visible p ORDER BY ${order} ${direction},p.id LIMIT ${pagination.pageSize} OFFSET ${pagination.offset})
    SELECT (SELECT count(*)::int FROM visible) AS total,coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.public_id,'name',p.name,'startDate',p.start_date::text,'endDate',p.end_date::text,'isAdmin',EXISTS(SELECT 1 FROM memberships m WHERE m.project_id=p.id AND m.user_id=${actor.user.id} AND m.is_admin),'memberCount',(SELECT count(*)::int FROM memberships m WHERE m.project_id=p.id)) ORDER BY ${order} ${direction},p.id) FROM selected p),'[]'::jsonb) AS items`)
    const value = result[0]
    if (!value) return yield* Effect.die(new Error("Missing collection result"))
    return paginated(value.items, value.total, pagination)
  }, execute)
  const create = Effect.fn("Projects.create")(function*(actor: Actor, input: typeof ProjectInput.Type) {
    return yield* sql.withTransaction(Effect.gen(function*() {
      yield* auth.lockActor(actor)
      const id = randomUUID()
      const inserted = yield* rows(Schema.Struct({ id: Schema.String }), sql`INSERT INTO projects(id,name,start_date,end_date) VALUES (${id},${input.name},${input.startDate},${input.endDate}) RETURNING public_id AS id`)
      const created = inserted[0]
      if (!created) return yield* Effect.die(new Error("Project insert returned no row"))
      yield* sql`INSERT INTO memberships(project_id,user_id,is_admin) VALUES (${id},${actor.user.id},true)`
      yield* sql`INSERT INTO stores(id,project_id) VALUES (${randomUUID()},${id})`
      return yield* get(actor, created.id)
    }))
  }, execute)
  const update = Effect.fn("Projects.update")((actor: Actor, id: string, input: typeof ProjectPatch.Type) => projectTransaction(actor, id, true, (project, current) => Effect.gen(function*() {
    const name = input.name ?? project.name, start = input.startDate ?? project.startDate, end = input.endDate ?? project.endDate
    if (start > end) return yield* invalid()
    yield* sql`UPDATE projects SET name=${name},start_date=${start},end_date=${end} WHERE id=${project.internalId}`
    return yield* get(current, id)
  })), execute)
  const remove = Effect.fn("Projects.remove")((actor: Actor, id: string) => projectTransaction(actor, id, true, (project) => Effect.gen(function*() {
    const now = new Date(yield* Clock.currentTimeMillis).toISOString()
    yield* sql`UPDATE projects SET deleted_at=${now} WHERE id=${project.internalId}`
    yield* sql`UPDATE invitations SET status='Withdrawn' WHERE project_id=${project.internalId} AND status='Pending'`
  })), execute)
  return { get, list, create, update, remove }
})
export class Projects extends Context.Service<Projects, Effect.Success<typeof makeProjects>>()("sitetrack/Projects") {
  static readonly layer = Layer.effect(Projects, makeProjects)
}
