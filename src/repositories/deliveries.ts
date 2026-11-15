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
  const found = yield* rows(
    Schema.Struct({ visible: Schema.Boolean, items: Schema.Array(Snapshot), total: Schema.Int }),
    sql`WITH scope AS (
    SELECT p.id FROM projects p WHERE (${projectId === undefined} OR (p.public_id=${projectId ?? ""} AND p.deleted_at IS NULL
      AND (${actor.user.role === "SuperAdmin"} OR EXISTS(SELECT 1 FROM memberships m WHERE m.project_id=p.id AND m.user_id=${actor.user.id}))))
    AND (${query.projectId === undefined} OR p.public_id=${query.projectId ?? ""})
  ), filtered AS (
    SELECT d.* FROM deliveries d JOIN scope s ON s.id=d.project_id
    WHERE (${query.status === undefined} OR d.status=${query.status ?? ""})
      AND (${query.direction === undefined} OR d.direction=${query.direction ?? ""})
      AND (${query.fromDate === undefined} OR d.initiated_at >= (${query.fromDate ?? "0001-01-01"}::date::timestamp AT TIME ZONE 'UTC'))
      AND (${query.toDate === undefined} OR d.initiated_at < ((${query.toDate ?? "9999-12-30"}::date+1)::timestamp AT TIME ZONE 'UTC'))
  ), selected AS (SELECT * FROM filtered ORDER BY initiated_at DESC,id DESC LIMIT ${pagination.pageSize} OFFSET ${pagination.offset})
  SELECT (${projectId === undefined} OR EXISTS(SELECT 1 FROM scope)) AS visible,(SELECT count(*)::int FROM filtered) AS total,
    coalesce((SELECT jsonb_agg(jsonb_build_object('value',${deliveryJson(sql)},'projectActive',p.deleted_at IS NULL,
      'member',EXISTS(SELECT 1 FROM memberships m WHERE m.project_id=p.id AND m.user_id=${actor.user.id})) ORDER BY d.initiated_at DESC,d.id DESC)
    FROM selected d JOIN projects p ON p.id=d.project_id JOIN users u ON u.id=d.initiated_by LEFT JOIN users c ON c.id=d.closed_by),'[]'::jsonb) AS items`
  )
  const result = found[0]
  if (!result?.visible) return yield* notFound()
  return paginated(
    result.items.map((item) => projectSnapshot(item, actor)),
    result.total,
    pagination
  )
})
