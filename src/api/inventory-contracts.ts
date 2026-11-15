import { HttpApiEndpoint as Endpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
import * as M from "../domain/inventory-models.js"
import { collection, Empty, ProjectId, Uuid } from "../domain/models.js"
import { Authentication } from "./contracts.js"
import { errors } from "./common.js"

const material = { materialId: Uuid },
  project = { projectId: ProjectId },
  delivery = { id: Uuid }
export const InventoryApi = HttpApiGroup.make("inventory")
  .add(
    Endpoint.get("materials", "/api/v1/materials", {
      query: M.MaterialQuery,
      success: collection(M.Material),
      error: errors
    }),
    Endpoint.get("material", "/api/v1/materials/:materialId", { params: material, success: M.Material, error: errors }),
    Endpoint.post("createMaterial", "/api/v1/materials", {
      payload: M.MaterialInput,
      success: M.Material.annotate({ httpApiStatus: 201 }),
      error: errors
    }),
    Endpoint.patch("updateMaterial", "/api/v1/materials/:materialId", {
      params: material,
      payload: M.MaterialPatch,
      success: M.Material,
      error: errors
    }),
    Endpoint.delete("deleteMaterial", "/api/v1/materials/:materialId", {
      params: material,
      success: HttpApiSchema.NoContent,
      error: errors
    }),
    Endpoint.get("companyStock", "/api/v1/company-store/stock", {
      query: M.StockQuery,
      success: collection(M.CompanyStock),
      error: errors
    }),
    Endpoint.post("addStock", "/api/v1/company-store/stock/additions", {
      payload: M.StockAdditionInput,
      headers: M.CommandHeaders,
      success: M.StockAddition.annotate({ httpApiStatus: 201 }),
      error: errors
    }),
    Endpoint.put("reorderPoint", "/api/v1/company-store/stock/:materialId/reorder-point", {
      params: material,
      payload: M.ReorderInput,
      success: M.CompanyStock,
      error: errors
    }),
    Endpoint.get("projectStock", "/api/v1/projects/:projectId/store", {
      params: project,
      query: M.ProjectStockQuery,
      success: collection(M.ProjectStock),
      error: errors
    }),
    Endpoint.get("companyDeliveries", "/api/v1/company-store/deliveries", {
      query: M.CompanyDeliveryQuery,
      success: collection(M.Delivery),
      error: errors
    }),
    Endpoint.post("createCompanyDelivery", "/api/v1/company-store/deliveries", {
      payload: M.CompanyDeliveryInput,
      headers: M.CommandHeaders,
      success: M.Delivery.annotate({ httpApiStatus: 201 }),
      error: errors
    }),
    Endpoint.get("projectDeliveries", "/api/v1/projects/:projectId/deliveries", {
      params: project,
      query: M.DeliveryQuery,
      success: collection(M.Delivery),
      error: errors
    }),
    Endpoint.post("createProjectDelivery", "/api/v1/projects/:projectId/deliveries", {
      params: project,
      payload: M.DeliveryInput,
      headers: M.CommandHeaders,
      success: M.Delivery.annotate({ httpApiStatus: 201 }),
      error: errors
    }),
    Endpoint.get("delivery", "/api/v1/deliveries/:id", { params: delivery, success: M.Delivery, error: errors }),
    Endpoint.post("recordDelivery", "/api/v1/deliveries/:id/record", {
      params: delivery,
      payload: Empty,
      headers: M.CommandHeaders,
      success: M.Delivery,
      error: errors
    }),
    Endpoint.post("rejectDelivery", "/api/v1/deliveries/:id/reject", {
      params: delivery,
      payload: Empty,
      headers: M.CommandHeaders,
      success: M.Delivery,
      error: errors
    }),
    Endpoint.post("cancelDelivery", "/api/v1/deliveries/:id/cancel", {
      params: delivery,
      payload: Empty,
      headers: M.CommandHeaders,
      success: M.Delivery,
      error: errors
    })
  )
  .middleware(Authentication)
  .annotate(
    OpenApi.Description,
    "Materials are shared by all authenticated roles. Stock and delivery permissions follow the source/destination store. Company-store access does not grant project task/member access. Quantities are plain decimal strings (14 integral, up to 6 fractional digits), never JSON numbers; amounts must be positive, reorder points may be zero. Catalogue text is trimmed; names/categories/units cap at 200/100/40 UTF-16 code units. Deliveries contain 1–100 distinct materials, immutable name/unit snapshots and exact quantities. CompanyToProject means incoming at the project and outgoing at the company; ProjectToCompany is the reverse. Date filters cover inclusive UTC initiation dates. Terminal commands use {}. Optional Idempotency-Key (1–128 letters/digits/._:-) applies to additions, initiation and terminal commands: matching retries return the original saved success snapshot after current authorization; different normalized requests conflict. Read detail for current state. Insufficient stock, quantity overflow, closed deliveries, material/unit/delete guards and key conflicts return 409; overflow preserves all state. No inventory command requires the auth-only CSRF header."
  )
