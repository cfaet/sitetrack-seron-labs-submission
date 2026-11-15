import { randomUUID } from "node:crypto"
import { Context, Effect, Layer } from "effect"
import { CompanyTime } from "../config/company.js"
import type { Actor } from "../domain/models.js"
import * as M from "../domain/inventory-models.js"
import { conflict, forbidden } from "../domain/errors.js"
import { deliveryActions, terminalStatus } from "../domain/inventory.js"
import { balanceFailure, canonicalQuantity, formatQuantity, quantityUnits } from "../domain/quantities.js"
import { Database, execute } from "../repositories/database.js"
import { companyStoreId, inventoryProject, lockBalance, lockMaterials } from "../repositories/inventory.js"
import { deliveryLines, deliveryRecord, readDeliveries, readDelivery } from "../repositories/deliveries.js"
import { Auth } from "./auth.js"
import { idempotent } from "./idempotency.js"

const makeDeliveries = Effect.gen(function* () {
  const sql = yield* Database,
    auth = yield* Auth,
    clock = yield* CompanyTime
  const bind = <A, E>(effect: Effect.Effect<A, E, Database>) => effect.pipe(Effect.provideService(Database, sql))
  const fresh = (actor: Actor) => Effect.map(auth.user(actor.user.id), (user) => ({ ...actor, user }))
  const transaction = <A, E, R>(actor: Actor, run: (current: Actor) => Effect.Effect<A, E, R>) =>
    sql.withTransaction(Effect.flatMap(auth.lockActor(actor), run))
  const authorizeInitiation = (actor: Actor, projectId: string, direction: M.DeliveryDirection) =>
    Effect.gen(function* () {
      const current = yield* fresh(actor)
      yield* inventoryProject(current, projectId, direction === "CompanyToProject")
      return current
    })
  const authorizeAction = (actor: Actor, id: string, action: M.DeliveryAction) =>
    Effect.gen(function* () {
      const current = yield* fresh(actor),
        delivery = yield* deliveryRecord(current, id)
      // Replays reauthorize the operation without requiring the saved delivery to remain InTransit.
      if (
        !deliveryActions(
          "InTransit",
          delivery.direction,
          current.user.role,
          delivery.projectActive && delivery.member
        ).includes(action)
      )
        return yield* forbidden()
      return current
    })
  const get = Effect.fn("Deliveries.get")((actor: Actor, id: string) => readDelivery(actor, id), execute, bind)
  const companyList = Effect.fn("Deliveries.companyList")(
    (actor: Actor, query: typeof M.CompanyDeliveryQuery.Type) => readDeliveries(actor, query),
    execute,
    bind
  )
  const projectList = Effect.fn("Deliveries.projectList")(
    (actor: Actor, projectId: string, query: typeof M.DeliveryQuery.Type) => readDeliveries(actor, query, projectId),
    execute,
    bind
  )
  const initiate = Effect.fn("Deliveries.initiate")(
    (
      actor: Actor,
      projectId: string,
      direction: M.DeliveryDirection,
      input: typeof M.DeliveryInput.Type,
      key?: string
    ) =>
      transaction(actor, (current) => {
        const lines = input.lines
          .map((line) => ({ materialId: line.materialId.toLowerCase(), quantity: canonicalQuantity(line.quantity) }))
          .sort((a, b) => a.materialId.localeCompare(b.materialId))
        return idempotent(
          current,
          "delivery.initiate",
          key,
          { projectId, direction, lines },
          M.Delivery,
          201,
          authorizeInitiation(current, projectId, direction),
          (authorized) =>
            Effect.gen(function* () {
              const materials = yield* lockMaterials(lines.map((line) => line.materialId))
              const project = yield* inventoryProject(authorized, projectId, direction === "CompanyToProject", true)
              const source = direction === "CompanyToProject" ? companyStoreId : project.storeId
              const updates: Array<{ materialId: string; quantity: string; next: string; name: string; unit: string }> =
                []
              for (const line of lines) {
                const balance = yield* lockBalance(source, line.materialId)
                const next = quantityUnits(balance) - quantityUnits(line.quantity),
                  failure = balanceFailure(next)
                if (failure) return yield* conflict(failure, "The source does not have the required stock.")
                const material = materials.find((item) => item.id === line.materialId)
                if (!material) return yield* Effect.die(new Error("Missing locked delivery material"))
                updates.push({ ...line, next: formatQuantity(next), name: material.name, unit: material.unit })
              }
              const latest = yield* authorizeInitiation(authorized, projectId, direction)
              const id = randomUUID(),
                now = yield* clock.now
              yield* sql`INSERT INTO deliveries(id,project_id,direction,initiated_at,initiated_by) VALUES (${id},${project.id},${direction},${now.instant},${latest.user.id})`
              for (const line of updates) {
                yield* sql`INSERT INTO delivery_lines(delivery_id,material_id,material_name,unit,quantity) VALUES (${id},${line.materialId},${line.name},${line.unit},${line.quantity}::numeric)`
                yield* sql`UPDATE stock_balances SET quantity=${line.next}::numeric,last_delivery_at=${now.instant} WHERE store_id=${source} AND material_id=${line.materialId}`
                yield* sql`INSERT INTO stock_movements(id,store_id,material_id,delta,kind,delivery_id,phase,actor_id,created_at)
            VALUES (${randomUUID()},${source},${line.materialId},${formatQuantity(-quantityUnits(line.quantity))}::numeric,'Dispatch',${id},'Dispatch',${latest.user.id},${now.instant})`
              }
              return yield* readDelivery(latest, id)
            })
        )
      }),
    execute,
    bind
  )
  const action = Effect.fn("Deliveries.action")(
    (actor: Actor, id: string, action: M.DeliveryAction, key?: string) =>
      transaction(actor, (current) =>
        idempotent(
          current,
          `delivery.${action}`,
          key,
          { id: id.toLowerCase() },
          M.Delivery,
          200,
          authorizeAction(current, id, action),
          (authorized) =>
            Effect.gen(function* () {
              const initial = yield* deliveryRecord(authorized, id)
              if (initial.status !== "InTransit")
                return yield* conflict("DELIVERY_STATE_CONFLICT", "The delivery already has a terminal state.")
              const lines = yield* deliveryLines(id)
              if (lines.length === 0) return yield* Effect.die(new Error("Delivery has no immutable lines"))
              yield* lockMaterials(lines.map((line) => line.materialId))
              const companySide = initial.direction === "CompanyToProject" ? action === "cancel" : action !== "cancel"
              const project = yield* inventoryProject(authorized, initial.publicProjectId, companySide, true)
              yield* sql`SELECT id FROM deliveries WHERE id=${id} FOR UPDATE`
              const locked = yield* deliveryRecord(yield* fresh(authorized), id)
              if (locked.status !== "InTransit")
                return yield* conflict("DELIVERY_STATE_CONFLICT", "The delivery already has a terminal state.")
              const source = locked.direction === "CompanyToProject" ? companyStoreId : project.storeId
              const destination = locked.direction === "CompanyToProject" ? project.storeId : companyStoreId
              const store = action === "record" ? destination : source
              const updates: Array<{ materialId: string; quantity: string; next: string }> = []
              for (const line of lines) {
                const balance = yield* lockBalance(store, line.materialId)
                const next = quantityUnits(balance) + quantityUnits(line.quantity),
                  failure = balanceFailure(next)
                if (failure) return yield* conflict(failure, "The resulting stock quantity exceeds its allowed range.")
                updates.push({ ...line, next: formatQuantity(next) })
              }
              const latest = yield* authorizeAction(authorized, id, action),
                now = yield* clock.now
              yield* sql`UPDATE deliveries SET status=${terminalStatus(action)},closed_at=${now.instant},closed_by=${latest.user.id} WHERE id=${id}`
              const kind =
                action === "record" ? "Receipt" : action === "reject" ? "RejectionRefund" : "CancellationRefund"
              for (const line of updates) {
                yield* sql`UPDATE stock_balances SET quantity=${line.next}::numeric,last_delivery_at=${now.instant} WHERE store_id=${store} AND material_id=${line.materialId}`
                yield* sql`INSERT INTO stock_movements(id,store_id,material_id,delta,kind,delivery_id,phase,actor_id,created_at)
            VALUES (${randomUUID()},${store},${line.materialId},${line.quantity}::numeric,${kind},${id},'Terminal',${latest.user.id},${now.instant})`
              }
              return yield* readDelivery(latest, id)
            })
        )
      ),
    execute,
    bind
  )
  return { get, companyList, projectList, initiate, action }
})
export class Deliveries extends Context.Service<Deliveries, Effect.Success<typeof makeDeliveries>>()(
  "sitetrack/Deliveries"
) {
  static readonly layer = Layer.effect(Deliveries, makeDeliveries)
}
