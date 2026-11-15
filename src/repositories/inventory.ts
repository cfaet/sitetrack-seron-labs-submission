import { Effect, Schema } from "effect"
import type { Actor } from "../domain/models.js"
import * as M from "../domain/inventory-models.js"
import { forbidden, notFound } from "../domain/errors.js"
import { canUseCompanyStore } from "../domain/inventory.js"
import { canonicalQuantity } from "../domain/quantities.js"
import { Database, page, paginated, rows } from "./database.js"

export const companyStoreId = "00000000-0000-4000-8000-000000000001"
const ProjectInfo = Schema.Struct({
  id: Schema.String,
  publicId: Schema.String,
  name: Schema.String,
  storeId: Schema.String,
  member: Schema.Boolean
})
export const inventoryProject = Effect.fn("inventoryProject")(function* (
  actor: Actor,
  id: string,
  companySide: boolean,
  lock = false
) {
  const sql = yield* Database
  if (companySide && !canUseCompanyStore(actor.user.role)) return yield* forbidden()
  if (lock) {
    const locked = yield* sql`SELECT id FROM projects WHERE public_id=${id} AND deleted_at IS NULL FOR UPDATE`
    if (locked.length === 0) return yield* notFound()
  }
  const found = yield* rows(
    ProjectInfo,
    sql`SELECT p.id::text,p.public_id AS "publicId",p.name,s.id::text AS "storeId",
    EXISTS(SELECT 1 FROM memberships m WHERE m.project_id=p.id AND m.user_id=${actor.user.id}) AS member
    FROM projects p JOIN stores s ON s.project_id=p.id WHERE p.public_id=${id} AND p.deleted_at IS NULL`
  )
  const project = found[0]
  if (!project) return yield* notFound()
  if (companySide) {
    if (!canUseCompanyStore(actor.user.role)) return yield* forbidden()
  } else if (actor.user.role !== "SuperAdmin" && !project.member) return yield* notFound()
  return project
})

export const lockMaterials = Effect.fn("lockMaterials")(function* (ids: ReadonlyArray<string>, exclusive = false) {
  const sql = yield* Database
  const found = yield* rows(
    M.Material,
    sql`SELECT id::text,name,category,unit FROM materials
    WHERE ${sql.in("id", ids)} AND deleted_at IS NULL ORDER BY id ${exclusive ? sql`FOR UPDATE` : sql`FOR SHARE`}`
  )
  if (found.length !== ids.length) return yield* notFound()
  return found
})
export const material = Effect.fn("material")(function* (id: string) {
  const sql = yield* Database
  const found = yield* rows(
    M.Material,
    sql`SELECT id::text,name,category,unit FROM materials WHERE id=${id} AND deleted_at IS NULL`
  )
  const value = found[0]
  if (!value) return yield* notFound()
  return value
})
export const materialList = Effect.fn("materialList")(function* (query: typeof M.MaterialQuery.Type) {
  const sql = yield* Database,
    pagination = page(query)
  const found = yield* rows(
    Schema.Struct({ items: Schema.Array(M.Material), total: Schema.Int }),
    sql`WITH visible AS (
    SELECT id,name,category,unit FROM materials WHERE deleted_at IS NULL
    AND strpos(lower(name),lower(${query.search ?? ""}))>0 AND (${query.category === undefined} OR lower(category)=lower(${query.category ?? ""}))
  ), selected AS (SELECT * FROM visible ORDER BY lower(name),id LIMIT ${pagination.pageSize} OFFSET ${pagination.offset})
  SELECT (SELECT count(*)::int FROM visible) AS total,coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'category',category,'unit',unit) ORDER BY lower(name),id) FROM selected),'[]'::jsonb) AS items`
  )
  const result = found[0]
  if (!result) return yield* Effect.die(new Error("Missing material collection"))
  return paginated(result.items, result.total, pagination)
})
export const companyStock = Effect.fn("companyStock")(function* (
  actor: Actor,
  query: typeof M.StockQuery.Type,
  materialId?: string
) {
  if (!canUseCompanyStore(actor.user.role)) return yield* forbidden()
  const sql = yield* Database,
    pagination = page(query)
  const order =
    query.sort === "quantity" ? sql`p.quantity` : query.sort === "status" ? sql`p.status_rank` : sql`lower(p.name)`
  const direction = query.direction === "desc" ? sql`DESC` : sql`ASC`
  const found = yield* rows(
    Schema.Struct({ items: Schema.Array(M.CompanyStock), total: Schema.Int }),
    sql`WITH base AS (
    SELECT m.*,coalesce(b.quantity,0::numeric) AS quantity,coalesce(b.reorder_point,0::numeric) AS reorder_point
    FROM materials m LEFT JOIN stock_balances b ON b.material_id=m.id AND b.store_id=${companyStoreId}
    WHERE m.deleted_at IS NULL AND (${materialId === undefined} OR m.id=${materialId ?? "00000000-0000-0000-0000-000000000000"}::uuid)
    AND strpos(lower(m.name),lower(${query.search ?? ""}))>0 AND (${query.category === undefined} OR lower(m.category)=lower(${query.category ?? ""}))
  ), enriched AS (
    SELECT *,CASE WHEN quantity=0 THEN 'OutOfStock' WHEN quantity<=reorder_point THEN 'LowStock' ELSE 'Available' END AS status,
    CASE WHEN quantity=0 THEN 0 WHEN quantity<=reorder_point THEN 1 ELSE 2 END AS status_rank FROM base
  ), filtered AS (SELECT * FROM enriched WHERE (${query.status === undefined} OR status=${query.status ?? ""})),
  selected AS (SELECT p.* FROM filtered p ORDER BY ${order} ${direction},p.id LIMIT ${pagination.pageSize} OFFSET ${pagination.offset}),
  transit AS (SELECT l.material_id,sum(l.quantity) AS quantity FROM delivery_lines l JOIN selected p ON p.id=l.material_id
    JOIN deliveries d ON d.id=l.delivery_id WHERE d.direction='CompanyToProject' AND d.status='InTransit' GROUP BY l.material_id)
  SELECT (SELECT count(*)::int FROM filtered) AS total,coalesce((SELECT jsonb_agg(jsonb_build_object(
    'material',jsonb_build_object('id',p.id,'name',p.name,'category',p.category,'unit',p.unit),
    'quantity',p.quantity::text,'reorderPoint',p.reorder_point::text,'status',p.status,
    'inTransitQuantity',coalesce(t.quantity,0)::text) ORDER BY ${order} ${direction},p.id)
    FROM selected p LEFT JOIN transit t ON t.material_id=p.id),'[]'::jsonb) AS items`
  )
  const result = found[0]
  if (!result) return yield* Effect.die(new Error("Missing company stock collection"))
  return paginated(
    result.items.map((item) => ({
      ...item,
      quantity: canonicalQuantity(item.quantity),
      reorderPoint: canonicalQuantity(item.reorderPoint),
      inTransitQuantity: canonicalQuantity(item.inTransitQuantity)
    })),
    result.total,
    pagination
  )
})
export const projectStock = Effect.fn("projectStock")(function* (
  actor: Actor,
  id: string,
  query: typeof M.ProjectStockQuery.Type
) {
  const sql = yield* Database,
    pagination = page(query)
  const order =
    query.sort === "quantity"
      ? sql`p.quantity`
      : query.sort === "lastDelivery"
        ? sql`p.last_delivery_at`
        : sql`lower(p.name)`
  const direction = query.direction === "desc" ? sql`DESC` : sql`ASC`
  const found = yield* rows(
    Schema.Struct({ visible: Schema.Boolean, items: Schema.Array(M.ProjectStock), total: Schema.Int }),
    sql`WITH visible AS (
    SELECT s.id FROM stores s JOIN projects p ON p.id=s.project_id WHERE p.public_id=${id} AND p.deleted_at IS NULL
    AND (${actor.user.role === "SuperAdmin"} OR EXISTS(SELECT 1 FROM memberships m WHERE m.project_id=p.id AND m.user_id=${actor.user.id}))
  ), filtered AS (
    SELECT m.*,b.quantity,b.last_delivery_at FROM visible v JOIN stock_balances b ON b.store_id=v.id
    JOIN materials m ON m.id=b.material_id AND m.deleted_at IS NULL
    WHERE strpos(lower(m.name),lower(${query.search ?? ""}))>0 AND (${query.category === undefined} OR lower(m.category)=lower(${query.category ?? ""}))
  ), selected AS (SELECT p.* FROM filtered p ORDER BY ${order} ${direction} NULLS LAST,p.id LIMIT ${pagination.pageSize} OFFSET ${pagination.offset})
  SELECT EXISTS(SELECT 1 FROM visible) AS visible,(SELECT count(*)::int FROM filtered) AS total,
  coalesce((SELECT jsonb_agg(jsonb_build_object('material',jsonb_build_object('id',p.id,'name',p.name,'category',p.category,'unit',p.unit),
    'quantity',p.quantity::text,'lastDeliveryAt',to_char(p.last_delivery_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    ORDER BY ${order} ${direction} NULLS LAST,p.id) FROM selected p),'[]'::jsonb) AS items`
  )
  const result = found[0]
  if (!result?.visible) return yield* notFound()
  return paginated(
    result.items.map((item) => ({ ...item, quantity: canonicalQuantity(item.quantity) })),
    result.total,
    pagination
  )
})

export const lockBalance = Effect.fn("lockBalance")(function* (storeId: string, materialId: string) {
  const sql = yield* Database
  yield* sql`INSERT INTO stock_balances(store_id,material_id) VALUES (${storeId},${materialId}) ON CONFLICT DO NOTHING`
  const found = yield* rows(
    Schema.Struct({ quantity: M.Quantity }),
    sql`SELECT quantity::text FROM stock_balances WHERE store_id=${storeId} AND material_id=${materialId} FOR UPDATE`
  )
  const balance = found[0]
  if (!balance) return yield* Effect.die(new Error("Missing locked stock balance"))
  return balance.quantity
})
