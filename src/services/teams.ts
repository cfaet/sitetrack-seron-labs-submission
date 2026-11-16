import { randomUUID } from "node:crypto"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { Actor, Invitation, ListQuery, Member, Notification } from "../domain/models.js"
import { conflict, notFound } from "../domain/errors.js"
import { Database, execute, page, paginated, rows } from "../repositories/database.js"
import { Auth } from "./auth.js"
import { projectAccess, projectTransaction } from "./access.js"
const Count = Schema.Struct({ count: Schema.Int })
const inviteRecord = Schema.Struct({ projectId: Schema.String, recipient: Schema.String, status: Schema.String })
const makeTeams = Effect.gen(function* () {
  const sql = yield* Database,
    auth = yield* Auth
  const memberList = Effect.fn("Teams.members")(function* (actor: Actor, projectId: string, query: ListQuery) {
    const project = yield* projectAccess(actor, projectId),
      pagination = page(query)
    const result = yield* rows(
      Schema.Struct({ items: Schema.Array(Member), total: Schema.Int }),
      sql`WITH visible AS (
      SELECT u.id,u.name,u.email,u.role,u.created_at,m.is_admin FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.project_id=${project.internalId}
    ), selected AS (SELECT * FROM visible ORDER BY lower(name),id LIMIT ${pagination.pageSize} OFFSET ${pagination.offset})
    SELECT (SELECT count(*)::int FROM visible) AS total,coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'email',email,'role',role,'createdAt',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'isAdmin',is_admin) ORDER BY lower(name),id) FROM selected),'[]'::jsonb) AS items`
    )
    const value = result[0]
    if (!value) return yield* Effect.die(new Error("Missing member collection"))
    return paginated(value.items, value.total, pagination)
  }, execute)
  const changeMember = Effect.fn("Teams.changeMember")(
    (actor: Actor, projectId: string, userId: string, isAdmin: boolean | undefined) =>
      projectTransaction(actor, projectId, true, (project) =>
        Effect.gen(function* () {
          const found = yield* rows(
            Schema.Struct({ isAdmin: Schema.Boolean }),
            sql`SELECT is_admin AS "isAdmin" FROM memberships WHERE project_id=${project.internalId} AND user_id=${userId}`
          )
          const member = found[0]
          if (!member) return yield* notFound()
          if (member.isAdmin && isAdmin !== true) {
            const counts = yield* rows(
              Count,
              sql`SELECT count(*)::int AS count FROM memberships WHERE project_id=${project.internalId} AND is_admin`
            )
            if ((counts[0]?.count ?? 0) <= 1)
              return yield* conflict("LAST_ADMIN", "A project must retain an administrator.")
          }
          if (isAdmin === undefined) {
            yield* sql`DELETE FROM memberships WHERE project_id=${project.internalId} AND user_id=${userId}`
            return
          }
          yield* sql`UPDATE memberships SET is_admin=${isAdmin} WHERE project_id=${project.internalId} AND user_id=${userId}`
        })
      ),
    execute
  )
  const invitation = Effect.fn("Teams.invitation")(function* (id: string) {
    const found = yield* rows(
      Invitation,
      sql`SELECT i.id::text,p.public_id AS "projectId",i.inviter_id::text AS "inviterId",i.status,to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",jsonb_build_object('id',u.id,'name',u.name,'email',u.email,'role',u.role,'createdAt',to_char(u.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS invitee FROM invitations i JOIN projects p ON p.id=i.project_id JOIN users u ON u.id=i.invitee_id WHERE i.id=${id}`
    )
    if (!found[0]) return yield* notFound()
    return found[0]
  })
  const invitations = Effect.fn("Teams.invitations")(function* (actor: Actor, projectId: string, query: ListQuery) {
    const project = yield* projectAccess(actor, projectId),
      pagination = page(query)
    const result = yield* rows(
      Schema.Struct({ items: Schema.Array(Invitation), total: Schema.Int }),
      sql`WITH visible AS (
      SELECT i.*,u.name,u.email,u.role,u.created_at AS user_created FROM invitations i JOIN users u ON u.id=i.invitee_id WHERE i.project_id=${project.internalId} AND i.status='Pending'
    ), selected AS (SELECT * FROM visible ORDER BY created_at DESC,id DESC LIMIT ${pagination.pageSize} OFFSET ${pagination.offset})
    SELECT (SELECT count(*)::int FROM visible) AS total,coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'projectId',${projectId}::text,'inviterId',inviter_id,'status',status,'createdAt',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'invitee',jsonb_build_object('id',invitee_id,'name',name,'email',email,'role',role,'createdAt',to_char(user_created AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) ORDER BY created_at DESC,id DESC) FROM selected),'[]'::jsonb) AS items`
    )
    const value = result[0]
    if (!value) return yield* Effect.die(new Error("Missing invitation collection"))
    return paginated(value.items, value.total, pagination)
  }, execute)
  const invite = Effect.fn("Teams.invite")(
    (actor: Actor, projectId: string, email: string) =>
      projectTransaction(actor, projectId, true, (project) =>
        Effect.gen(function* () {
          const users = yield* rows(
            Schema.Struct({ id: Schema.String }),
            sql`SELECT id::text FROM users WHERE email=${email.trim().toLowerCase()}`
          )
          const target = users[0]
          if (!target) return yield* notFound()
          if (target.id === actor.user.id) return yield* conflict("SELF_INVITATION", "Cannot invite yourself.")
          const existing =
            yield* sql`SELECT 1 FROM memberships WHERE project_id=${project.internalId} AND user_id=${target.id}`
          if (existing.length > 0) return yield* conflict("ALREADY_MEMBER", "User is already a member.")
          const id = randomUUID(),
            now = new Date(yield* Clock.currentTimeMillis).toISOString()
          yield* sql`INSERT INTO invitations(id,project_id,invitee_id,inviter_id,status,created_at) VALUES (${id},${project.internalId},${target.id},${actor.user.id},'Pending',${now})`
          yield* sql`INSERT INTO notifications(id,invitation_id,recipient_id,created_at) VALUES (${randomUUID()},${id},${target.id},${now})`
          return yield* invitation(id)
        })
      ),
    execute
  )
  const withdraw = Effect.fn("Teams.withdraw")(
    (actor: Actor, projectId: string, id: string) =>
      projectTransaction(actor, projectId, true, (project) =>
        Effect.gen(function* () {
          const found = yield* rows(
            Schema.Struct({ status: Schema.String }),
            sql`SELECT status FROM invitations WHERE id=${id} AND project_id=${project.internalId} FOR UPDATE`
          )
          if (!found[0]) return yield* notFound()
          if (found[0].status !== "Pending")
            return yield* conflict("INVITATION_CLOSED", "Invitation is no longer pending.")
          yield* sql`UPDATE invitations SET status='Withdrawn' WHERE id=${id}`
          return yield* invitation(id)
        })
      ),
    execute
  )
  const answer = Effect.fn("Teams.answer")(function* (actor: Actor, id: string, accept: boolean) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* auth.lockActor(actor)
        const located = yield* rows(
          inviteRecord,
          sql`SELECT p.public_id AS "projectId",i.invitee_id::text AS recipient,i.status FROM invitations i JOIN projects p ON p.id=i.project_id WHERE i.id=${id} AND i.invitee_id=${actor.user.id}`
        )
        const initial = located[0]
        if (!initial) return yield* notFound()
        const projects = yield* rows(
          Schema.Struct({ id: Schema.String, deleted: Schema.Boolean }),
          sql`SELECT id::text,deleted_at IS NOT NULL AS deleted FROM projects WHERE public_id=${initial.projectId} FOR UPDATE`
        )
        const project = projects[0]
        const current = yield* rows(
          inviteRecord,
          sql`SELECT ${initial.projectId} AS "projectId",invitee_id::text AS recipient,status FROM invitations WHERE id=${id} AND invitee_id=${actor.user.id} FOR UPDATE`
        )
        if (!project || project.deleted || current[0]?.status !== "Pending")
          return yield* conflict("INVITATION_CLOSED", "Invitation is no longer pending.")
        if (accept)
          yield* sql`INSERT INTO memberships(project_id,user_id,is_admin) VALUES (${project.id},${actor.user.id},false)`
        yield* sql`UPDATE invitations SET status=${accept ? "Accepted" : "Rejected"} WHERE id=${id}`
        const now = new Date(yield* Clock.currentTimeMillis).toISOString()
        yield* sql`UPDATE notifications SET read_at=coalesce(read_at,${now}::timestamptz) WHERE invitation_id=${id} AND recipient_id=${actor.user.id}`
        return yield* invitation(id)
      })
    )
  }, execute)
  const notifications = Effect.fn("Teams.notifications")(function* (actor: Actor, query: ListQuery) {
    const pagination = page(query)
    const result = yield* rows(
      Schema.Struct({ items: Schema.Array(Notification), total: Schema.Int }),
      sql`WITH visible AS (
      SELECT n.*,i.status,p.public_id,p.name,p.deleted_at FROM notifications n JOIN invitations i ON i.id=n.invitation_id JOIN projects p ON p.id=i.project_id WHERE n.recipient_id=${actor.user.id}
    ), selected AS (SELECT * FROM visible ORDER BY created_at DESC,id DESC LIMIT ${pagination.pageSize} OFFSET ${pagination.offset})
    SELECT (SELECT count(*)::int FROM visible) AS total,coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'project',jsonb_build_object('id',public_id,'name',name),'invitation',jsonb_build_object('id',invitation_id,'status',status),'createdAt',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'readAt',to_char(read_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'allowedActions',CASE WHEN status='Pending' AND deleted_at IS NULL THEN '["accept","reject"]'::jsonb ELSE '[]'::jsonb END) ORDER BY created_at DESC,id DESC) FROM selected),'[]'::jsonb) AS items`
    )
    const value = result[0]
    if (!value) return yield* Effect.die(new Error("Missing notification collection"))
    return paginated(value.items, value.total, pagination)
  }, execute)
  const unread = Effect.fn("Teams.unread")(function* (actor: Actor) {
    const counts = yield* rows(
      Count,
      sql`SELECT count(*)::int AS count FROM notifications WHERE recipient_id=${actor.user.id} AND read_at IS NULL`
    )
    if (!counts[0]) return yield* Effect.die(new Error("Missing unread count"))
    return counts[0]
  }, execute)
  const markRead = Effect.fn("Teams.markRead")(function* (actor: Actor, id: string) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* auth.lockActor(actor)
        const now = new Date(yield* Clock.currentTimeMillis).toISOString()
        const changed = yield* rows(
          Schema.Struct({ id: Schema.String, readAt: Schema.String }),
          sql`UPDATE notifications SET read_at=coalesce(read_at,${now}::timestamptz) WHERE id=${id} AND recipient_id=${actor.user.id} RETURNING id::text,to_char(read_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "readAt"`
        )
        if (!changed[0]) return yield* notFound()
        return changed[0]
      })
    )
  }, execute)
  return { memberList, changeMember, invite, invitations, withdraw, answer, notifications, unread, markRead }
})
export class Teams extends Context.Service<Teams, Effect.Success<typeof makeTeams>>()("sitetrack/Teams") {
  static readonly layer = Layer.effect(Teams, makeTeams)
}
