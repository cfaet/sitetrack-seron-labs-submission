import { Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { HttpServerRequest } from "effect/http"
import * as M from "../domain/inventory-models.js"
import { collection, Empty } from "../domain/models.js"
import { invalid } from "../domain/errors.js"
import { Inventory } from "../services/inventory.js"
import { Deliveries } from "../services/deliveries.js"
import { Api } from "./api.js"
import { CurrentActor } from "./contracts.js"
import { jsonResponse } from "./common.js"
import { guarded, readInput } from "./input.js"

const key = (request: HttpServerRequest.HttpServerRequest) => {
  const value = request.headers["idempotency-key"]
  return value === undefined
    ? Effect.undefined
    : Schema.decodeEffect(M.IdempotencyKey)(value).pipe(Effect.mapError(invalid))
}
export const InventoryHandlers = HttpApiBuilder.group(Api, "inventory", (handlers) =>
  handlers
    .handle("materials", ({ query }) =>
      guarded(
        Effect.gen(function* () {
          return yield* jsonResponse(collection(M.Material), yield* (yield* Inventory).list(yield* CurrentActor, query))
        })
      )
    )
    .handle("material", ({ params }) =>
      guarded(
        Effect.gen(function* () {
          return yield* jsonResponse(M.Material, yield* (yield* Inventory).get(yield* CurrentActor, params.materialId))
        })
      )
    )
    .handleRaw("createMaterial", ({ request }) =>
      guarded(
        Effect.gen(function* () {
          return yield* jsonResponse(
            M.Material,
            yield* (yield* Inventory).create(yield* CurrentActor, yield* readInput(M.MaterialInput, request)),
            201
          )
        })
      )
    )
    .handleRaw("updateMaterial", ({ params, request }) =>
      guarded(
        Effect.gen(function* () {
          return yield* jsonResponse(
            M.Material,
            yield* (yield* Inventory).update(
              yield* CurrentActor,
              params.materialId,
              yield* readInput(M.MaterialPatch, request)
            )
          )
        })
      )
    )
    .handle("deleteMaterial", ({ params }) =>
      guarded(
        Effect.gen(function* () {
          yield* (yield* Inventory).remove(yield* CurrentActor, params.materialId)
        })
      )
    )
    .handle("companyStock", ({ query }) =>
      guarded(
        Effect.gen(function* () {
          return yield* jsonResponse(
            collection(M.CompanyStock),
            yield* (yield* Inventory).company(yield* CurrentActor, query)
          )
        })
      )
    )
    .handleRaw("addStock", ({ request }) =>
      guarded(
        Effect.gen(function* () {
          return yield* jsonResponse(
            M.StockAddition,
            yield* (yield* Inventory).add(
              yield* CurrentActor,
              yield* readInput(M.StockAdditionInput, request),
              yield* key(request)
            ),
            201
          )
        })
      )
    )
    .handleRaw("reorderPoint", ({ params, request }) =>
      guarded(
        Effect.gen(function* () {
          return yield* jsonResponse(
            M.CompanyStock,
            yield* (yield* Inventory).reorder(
              yield* CurrentActor,
              params.materialId,
              yield* readInput(M.ReorderInput, request)
            )
          )
        })
      )
    )
    .handle("projectStock", ({ params, query }) =>
      guarded(
        Effect.gen(function* () {
          return yield* jsonResponse(
            collection(M.ProjectStock),
            yield* (yield* Inventory).project(yield* CurrentActor, params.projectId, query)
          )
        })
      )
    )
    .handle("companyDeliveries", ({ query }) =>
      guarded(
        Effect.gen(function* () {
          return yield* jsonResponse(
            collection(M.Delivery),
            yield* (yield* Deliveries).companyList(yield* CurrentActor, query)
          )
        })
      )
    )
    .handle("projectDeliveries", ({ params, query }) =>
      guarded(
        Effect.gen(function* () {
          return yield* jsonResponse(
            collection(M.Delivery),
            yield* (yield* Deliveries).projectList(yield* CurrentActor, params.projectId, query)
          )
        })
      )
    )
    .handleRaw("createCompanyDelivery", ({ request }) =>
      guarded(
        Effect.gen(function* () {
          const input = yield* readInput(M.CompanyDeliveryInput, request)
          return yield* jsonResponse(
            M.Delivery,
            yield* (yield* Deliveries).initiate(
              yield* CurrentActor,
              input.projectId,
              "CompanyToProject",
              input,
              yield* key(request)
            ),
            201
          )
        })
      )
    )
    .handleRaw("createProjectDelivery", ({ params, request }) =>
      guarded(
        Effect.gen(function* () {
          return yield* jsonResponse(
            M.Delivery,
            yield* (yield* Deliveries).initiate(
              yield* CurrentActor,
              params.projectId,
              "ProjectToCompany",
              yield* readInput(M.DeliveryInput, request),
              yield* key(request)
            ),
            201
          )
        })
      )
    )
    .handle("delivery", ({ params }) =>
      guarded(
        Effect.gen(function* () {
          return yield* jsonResponse(M.Delivery, yield* (yield* Deliveries).get(yield* CurrentActor, params.id))
        })
      )
    )
    .handleRaw("recordDelivery", ({ params, request }) =>
      guarded(
        Effect.gen(function* () {
          yield* readInput(Empty, request)
          return yield* jsonResponse(
            M.Delivery,
            yield* (yield* Deliveries).action(yield* CurrentActor, params.id, "record", yield* key(request))
          )
        })
      )
    )
    .handleRaw("rejectDelivery", ({ params, request }) =>
      guarded(
        Effect.gen(function* () {
          yield* readInput(Empty, request)
          return yield* jsonResponse(
            M.Delivery,
            yield* (yield* Deliveries).action(yield* CurrentActor, params.id, "reject", yield* key(request))
          )
        })
      )
    )
    .handleRaw("cancelDelivery", ({ params, request }) =>
      guarded(
        Effect.gen(function* () {
          yield* readInput(Empty, request)
          return yield* jsonResponse(
            M.Delivery,
            yield* (yield* Deliveries).action(yield* CurrentActor, params.id, "cancel", yield* key(request))
          )
        })
      )
    )
)
