import { Effect, Schema } from "effect"
import { Database, rows } from "../repositories/database.js"
import { Actor, Project } from "../domain/models.js"
import { forbidden, notFound } from "../domain/errors.js"
import { Auth } from "./auth.js"
export const ProjectRecord = Schema.Struct({ ...Project.fields, internalId: Schema.String })
export type ProjectRecord = typeof ProjectRecord.Type
export const projectAccess = Effect.fn("projectAccess")(function* (actor: Actor, publicId: string, admin = false) {
  const sql = yield* Database
  const found = yield* rows(
    ProjectRecord,
    sql`SELECT p.id::text AS "internalId",p.public_id AS id,p.name,p.start_date::text AS "startDate",p.end_date::text AS "endDate",
    EXISTS(SELECT 1 FROM memberships m WHERE m.project_id=p.id AND m.user_id=${actor.user.id} AND m.is_admin) AS "isAdmin",
    (SELECT count(*)::int FROM memberships m WHERE m.project_id=p.id) AS "memberCount"
    FROM projects p WHERE p.public_id=${publicId} AND p.deleted_at IS NULL AND
    (${actor.user.role === "SuperAdmin"} OR EXISTS(SELECT 1 FROM memberships m WHERE m.project_id=p.id AND m.user_id=${actor.user.id}))`
  )
  const project = found[0]
  if (!project) return yield* notFound()
  if (admin && !project.isAdmin) return yield* forbidden()
  return project
})
export const projectTransaction = <A, E, R>(
  actor: Actor,
  id: string,
  admin: boolean,
  run: (project: ProjectRecord, actor: Actor) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function* () {
    const sql = yield* Database,
      auth = yield* Auth
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* auth.lockActor(actor)
        const locked = yield* sql`SELECT id FROM projects WHERE public_id=${id} AND deleted_at IS NULL FOR UPDATE`
        if (locked.length === 0) return yield* notFound()
        const current = { ...actor, user: yield* auth.user(actor.user.id) }
        const project = yield* projectAccess(current, id, admin)
        return yield* run(project, current)
      })
    )
  })
