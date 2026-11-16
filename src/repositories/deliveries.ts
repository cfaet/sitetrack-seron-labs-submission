import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import type { Actor } from "../domain/models.js"
import * as M from "../domain/inventory-models.js"
import { forbidden, notFound } from "../domain/errors.js"
import { canUseCompanyStore, deliveryActions } from "../domain/inventory.js"
import { canonicalQuantity } from "../domain/quantities.js"
import { Database, page, paginated, rows } from "./database.js"

const Record = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  publicProjectId: Schema.String,
  direction: M.DeliveryDirection,
  status: M.DeliveryStatus,
  member: Schema.Boolean,
  projectActive: Schema.Boolean
})
export const deliveryRecord = Effect.fn("deliveryRecord")(function* (actor: Actor, id: string) {
  const sql = yield* Database
  const found = yield* rows(
    Record,
    sql`SELECT d.id::text,d.project_id::text AS "projectId",p.public_id AS "publicProjectId",d.direction,d.status,
    p.deleted_at IS NULL AS "projectActive",EXISTS(SELECT 1 FROM memberships m WHERE m.project_id=p.id AND m.user_id=${actor.user.id}) AS member
    FROM deliveries d JOIN projects p ON p.id=d.project_id WHERE d.id=${id}
    AND (${canUseCompanyStore(actor.user.role)} OR (p.deleted_at IS NULL AND EXISTS(SELECT 1 FROM memberships m WHERE m.project_id=p.id AND m.user_id=${actor.user.id})))`
  )
  const result = found[0]
  if (!result) return yield* notFound()
  return result
})
export const deliveryLines = Effect.fn("deliveryLines")(function* (id: string) {
  const sql = yield* Database
  return yield* rows(
    Schema.Struct({ materialId: Schema.String, quantity: M.PositiveQuantity }),
    sql`SELECT material_id::text AS "materialId",quantity::text FROM delivery_lines WHERE delivery_id=${id} ORDER BY material_id`
  )
})
const Snapshot = Schema.Struct({ value: M.Delivery, member: Schema.Boolean, projectActive: Schema.Boolean })
const deliveryJson = (sql: SqlClient.SqlClient) => sql`jsonb_build_object(
  'id',d.id,'project',jsonb_build_object('id',p.public_id,'name',p.name),'direction',d.direction,'status',d.status,
  'lines',coalesce((SELECT jsonb_agg(jsonb_build_object('material',jsonb_build_object('id',l.material_id,'name',l.material_name,'unit',l.unit),'quantity',l.quantity::text) ORDER BY l.material_id) FROM delivery_lines l WHERE l.delivery_id=d.id),'[]'::jsonb),
  'initiatedAt',to_char(d.initiated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'initiatedBy',jsonb_build_object('id',u.id,'name',u.name),
  'closedAt',to_char(d.closed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'closedBy',CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object('id',c.id,'name',c.name) END,
  'receivedAt',CASE WHEN d.status='Delivered' THEN to_char(d.closed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ELSE NULL END,
  'receivedBy',CASE WHEN d.status='Delivered' THEN jsonb_build_object('id',c.id,'name',c.name) ELSE NULL END,
  'allowedActions','[]'::jsonb)`
const projectSnapshot = (snapshot: typeof Snapshot.Type, actor: Actor): M.Delivery => ({
  ...snapshot.value,
  lines: snapshot.value.lines.map((line) => ({ ...line, quantity: canonicalQuantity(line.quantity) })),
  allowedActions: deliveryActions(
    snapshot.value.status,
    snapshot.value.direction,
    actor.user.role,
    snapshot.projectActive && snapshot.member
  )
})
export const readDelivery = Effect.fn("readDelivery")(function* (actor: Actor, id: string) {
  const sql = yield* Database
  const found = yield* rows(
    Snapshot,
    sql`SELECT ${deliveryJson(sql)} AS value,
    p.deleted_at IS NULL AS "projectActive",EXISTS(SELECT 1 FROM memberships m WHERE m.project_id=p.id AND m.user_id=${actor.user.id}) AS member
    FROM deliveries d JOIN projects p ON p.id=d.project_id JOIN users u ON u.id=d.initiated_by LEFT JOIN users c ON c.id=d.closed_by
    WHERE d.id=${id} AND (${canUseCompanyStore(actor.user.role)} OR (p.deleted_at IS NULL AND EXISTS(SELECT 1 FROM memberships m WHERE m.project_id=p.id AND m.user_id=${actor.user.id})))`
  )
  const snapshot = found[0]
  if (!snapshot) return yield* notFound()
  return projectSnapshot(snapshot, actor)
})
export const readDeliveries = Effect.fn("readDeliveries")(function* (
  actor: Actor,
  query: typeof M.CompanyDeliveryQuery.Type,
  projectId?: string
) {
  if (projectId === undefined && !canUseCompanyStore(actor.user.role)) return yield* forbidden()
  const sql = yield* Database,
    pagination = page(query)
  const scoped = projectId !== undefined || query.projectId !== undefined
  // Reuse predicates, not a materialized copy of every matching delivery.
  const filter = sql`${scoped ? sql`d.project_id IN (SELECT id FROM scope)` : sql`true`}
    ${query.status === undefined ? sql`` : sql`AND d.status=${query.status}`}
    ${query.direction === undefined ? sql`` : sql`AND d.direction=${query.direction}`}
    ${query.fromDate === undefined ? sql`` : sql`AND d.initiated_at >= (${query.fromDate}::date::timestamp AT TIME ZONE 'UTC')`}
    ${query.toDate === undefined ? sql`` : sql`AND d.initiated_at < ((${query.toDate}::date+1)::timestamp AT TIME ZONE 'UTC')`}`
  const found = yield* rows(
    Schema.Struct({ visible: Schema.Boolean, items: Schema.Array(Snapshot), total: Schema.Int }),
    sql`WITH scope AS (
    SELECT p.id FROM projects p WHERE ${
      projectId === undefined
        ? sql`true`
        : sql`p.public_id=${projectId} AND p.deleted_at IS NULL
      AND ${actor.user.role === "SuperAdmin" ? sql`true` : sql`EXISTS(SELECT 1 FROM memberships m WHERE m.project_id=p.id AND m.user_id=${actor.user.id})`}`
    }
    ${query.projectId === undefined ? sql`` : sql`AND p.public_id=${query.projectId}`}
  ), selected AS MATERIALIZED (
    SELECT d.id,d.initiated_at FROM deliveries d WHERE ${filter}
    ORDER BY d.initiated_at DESC,d.id DESC LIMIT ${pagination.pageSize} OFFSET ${pagination.offset}
  )
  SELECT ${projectId === undefined ? sql`true` : sql`EXISTS(SELECT 1 FROM scope)`} AS visible,
    (SELECT count(*)::int FROM deliveries d WHERE ${filter}) AS total,
    coalesce((SELECT jsonb_agg(jsonb_build_object('value',${deliveryJson(sql)},'projectActive',p.deleted_at IS NULL,
      'member',EXISTS(SELECT 1 FROM memberships m WHERE m.project_id=p.id AND m.user_id=${actor.user.id})) ORDER BY d.initiated_at DESC,d.id DESC)
    FROM selected s JOIN deliveries d ON d.id=s.id JOIN projects p ON p.id=d.project_id
    JOIN users u ON u.id=d.initiated_by LEFT JOIN users c ON c.id=d.closed_by),'[]'::jsonb) AS items`
  )
  const result = found[0]
  if (!result?.visible) return yield* notFound()
  return paginated(
    result.items.map((item) => projectSnapshot(item, actor)),
    result.total,
    pagination
  )
})
