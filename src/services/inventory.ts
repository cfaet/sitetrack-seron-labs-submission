import { randomUUID } from "node:crypto"
import { Context, Effect, Layer, Schema } from "effect"
import { CompanyTime } from "../config/company.js"
import { conflict, forbidden } from "../domain/errors.js"
import type { Actor } from "../domain/models.js"
import * as M from "../domain/inventory-models.js"
import { canUseCompanyStore } from "../domain/inventory.js"
import { balanceFailure, canonicalQuantity, formatQuantity, quantityUnits } from "../domain/quantities.js"
import { Database, execute, rows } from "../repositories/database.js"
import {
  companyStock,
  companyStoreId,
  lockBalance,
  lockMaterials,
  material,
  materialList,
  projectStock
} from "../repositories/inventory.js"
import { Auth } from "./auth.js"
import { idempotent } from "./idempotency.js"

const makeInventory = Effect.gen(function* () {
  const sql = yield* Database,
    auth = yield* Auth,
    clock = yield* CompanyTime
  const bind = <A, E>(effect: Effect.Effect<A, E, Database>) => effect.pipe(Effect.provideService(Database, sql))
  const companyActor = (actor: Actor) =>
    Effect.gen(function* () {
      const user = yield* auth.user(actor.user.id)
      if (!canUseCompanyStore(user.role)) return yield* forbidden()
      return { ...actor, user }
    })
  const transaction = <A, E, R>(actor: Actor, run: (current: Actor) => Effect.Effect<A, E, R>) =>
    sql.withTransaction(Effect.flatMap(auth.lockActor(actor), run))
  const list = Effect.fn("Inventory.materials")(
    (_actor: Actor, query: typeof M.MaterialQuery.Type) => materialList(query),
    execute,
    bind
  )
  const get = Effect.fn("Inventory.material")((_actor: Actor, id: string) => material(id), execute, bind)
  const create = Effect.fn("Inventory.createMaterial")(
    (actor: Actor, input: typeof M.MaterialInput.Type) =>
      transaction(actor, () =>
        Effect.gen(function* () {
          const id = randomUUID()
          yield* sql`INSERT INTO materials(id,name,category,unit) VALUES (${id},${input.name},${input.category},${input.unit})`
          return yield* material(id)
        })
      ),
    execute,
    bind
  )
  const update = Effect.fn("Inventory.updateMaterial")(
    (actor: Actor, id: string, input: typeof M.MaterialPatch.Type) =>
      transaction(actor, () =>
        Effect.gen(function* () {
          const locked = yield* lockMaterials([id], true),
            current = locked[0]
          if (!current) return yield* Effect.die(new Error("Missing locked material"))
          if (input.unit !== undefined && input.unit !== current.unit) {
            const references = yield* rows(
              Schema.Struct({ used: Schema.Boolean }),
              sql`SELECT
        EXISTS(SELECT 1 FROM stock_balances WHERE material_id=${id}) OR
        EXISTS(SELECT 1 FROM delivery_lines WHERE material_id=${id}) OR
        EXISTS(SELECT 1 FROM stock_movements WHERE material_id=${id}) AS used`
            )
            if (references[0]?.used)
              return yield* conflict(
                "MATERIAL_UNIT_LOCKED",
                "The material unit is fixed after stock or history exists."
              )
          }
          yield* sql`UPDATE materials SET name=${input.name ?? current.name},category=${input.category ?? current.category},unit=${input.unit ?? current.unit} WHERE id=${id}`
          return yield* material(id)
        })
      ),
    execute,
    bind
  )
  const remove = Effect.fn("Inventory.removeMaterial")(
    (actor: Actor, id: string) =>
      transaction(actor, () =>
        Effect.gen(function* () {
          yield* lockMaterials([id], true)
          const references = yield* rows(
            Schema.Struct({ used: Schema.Boolean }),
            sql`SELECT
      EXISTS(SELECT 1 FROM stock_balances WHERE material_id=${id} AND quantity>0) OR
      EXISTS(SELECT 1 FROM delivery_lines l JOIN deliveries d ON d.id=l.delivery_id WHERE l.material_id=${id} AND d.status='InTransit') AS used`
          )
          if (references[0]?.used)
            return yield* conflict("MATERIAL_IN_USE", "Stock or an in-transit delivery still references this material.")
          const now = yield* clock.now
          yield* sql`UPDATE materials SET deleted_at=${now.instant} WHERE id=${id}`
        })
      ),
    execute,
    bind
  )
  const company = Effect.fn("Inventory.companyStock")(
    (actor: Actor, query: typeof M.StockQuery.Type) => companyStock(actor, query),
    execute,
    bind
  )
  const project = Effect.fn("Inventory.projectStock")(
    (actor: Actor, id: string, query: typeof M.ProjectStockQuery.Type) => projectStock(actor, id, query),
    execute,
    bind
  )
  const add = Effect.fn("Inventory.addStock")(
    (actor: Actor, input: typeof M.StockAdditionInput.Type, key?: string) =>
      transaction(actor, (current) => {
        const materialId = input.materialId.toLowerCase(),
          quantity = canonicalQuantity(input.quantity)
        return idempotent(
          current,
          "stock.add",
          key,
          { materialId, quantity },
          M.StockAddition,
          201,
          companyActor(current),
          (authorized) =>
            Effect.gen(function* () {
              yield* lockMaterials([materialId])
              const balance = yield* lockBalance(companyStoreId, materialId)
              yield* companyActor(authorized)
              const next = quantityUnits(balance) + quantityUnits(quantity),
                failure = balanceFailure(next)
              if (failure) return yield* conflict(failure, "The resulting stock quantity exceeds its allowed range.")
              const id = randomUUID(),
                now = yield* clock.now
              yield* sql`UPDATE stock_balances SET quantity=${formatQuantity(next)}::numeric WHERE store_id=${companyStoreId} AND material_id=${materialId}`
              yield* sql`INSERT INTO stock_movements(id,store_id,material_id,delta,kind,actor_id,created_at)
          VALUES (${id},${companyStoreId},${materialId},${quantity}::numeric,'Addition',${authorized.user.id},${now.instant})`
              return { id, materialId, quantity, createdAt: now.instant }
            })
        )
      }),
    execute,
    bind
  )
  const reorder = Effect.fn("Inventory.reorderPoint")(
    (actor: Actor, id: string, input: typeof M.ReorderInput.Type) =>
      transaction(actor, (current) =>
        Effect.gen(function* () {
          yield* companyActor(current)
          yield* lockMaterials([id])
          yield* lockBalance(companyStoreId, id)
          const authorized = yield* companyActor(current)
          yield* sql`UPDATE stock_balances SET reorder_point=${canonicalQuantity(input.reorderPoint)}::numeric WHERE store_id=${companyStoreId} AND material_id=${id}`
          const result = yield* companyStock(authorized, {}, id),
            item = result.items[0]
          if (!item) return yield* Effect.die(new Error("Missing updated stock row"))
          return item
        })
      ),
    execute,
    bind
  )
  return { list, get, create, update, remove, company, project, add, reorder }
})
export class Inventory extends Context.Service<Inventory, Effect.Success<typeof makeInventory>>()(
  "sitetrack/Inventory"
) {
  static readonly layer = Layer.effect(Inventory, makeInventory)
}
