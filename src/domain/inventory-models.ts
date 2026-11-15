import { Schema } from "effect"
import { CalendarDate, ListQuery, ProjectId, Uuid } from "./models.js"
import { isDecimal, isQuantity, quantityUnits } from "./quantities.js"

export const Quantity = Schema.String.check(
  Schema.makeFilter(isQuantity, { expected: "plain decimal with at most 14 integral and 6 fractional digits" })
)
export const PositiveQuantity = Quantity.check(
  Schema.makeFilter((value) => quantityUnits(value) > 0n, { expected: "positive quantity" })
)
// Aggregates may exceed numeric(20,6); they are still exact, finite, plain decimal strings.
export const Decimal = Schema.String.check(Schema.makeFilter(isDecimal, { expected: "nonnegative plain decimal" }))
const text = (max: number) => Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(max))
export const MaterialInput = Schema.Struct({ name: text(200), category: text(100), unit: text(40) })
export const MaterialPatch = Schema.Struct({
  name: Schema.optionalKey(text(200)),
  category: Schema.optionalKey(text(100)),
  unit: Schema.optionalKey(text(40))
}).check(Schema.makeFilter((input) => Object.keys(input).length > 0, { expected: "at least one editable field" }))
export const Material = Schema.Struct({ id: Uuid, ...MaterialInput.fields })
export type Material = typeof Material.Type
export const MaterialQuery = Schema.Struct({
  ...ListQuery.fields,
  search: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  category: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(100)))
})
export const StockStatus = Schema.Literals(["OutOfStock", "LowStock", "Available"])
export const ProjectStock = Schema.Struct({
  material: Material,
  quantity: Quantity,
  lastDeliveryAt: Schema.NullOr(Schema.String)
})
export const CompanyStock = Schema.Struct({
  material: Material,
  quantity: Quantity,
  inTransitQuantity: Decimal,
  reorderPoint: Quantity,
  status: StockStatus
})
export const StockQuery = Schema.Struct({
  ...MaterialQuery.fields,
  status: Schema.optionalKey(StockStatus),
  sort: Schema.optionalKey(Schema.Literals(["name", "quantity", "status"])),
  direction: Schema.optionalKey(Schema.Literals(["asc", "desc"]))
})
export const ProjectStockQuery = Schema.Struct({
  ...MaterialQuery.fields,
  sort: Schema.optionalKey(Schema.Literals(["name", "quantity", "lastDelivery"])),
  direction: Schema.optionalKey(Schema.Literals(["asc", "desc"]))
})
export const StockAdditionInput = Schema.Struct({ materialId: Uuid, quantity: PositiveQuantity })
export const StockAddition = Schema.Struct({
  id: Uuid,
  materialId: Uuid,
  quantity: PositiveQuantity,
  createdAt: Schema.String
})
export const ReorderInput = Schema.Struct({ reorderPoint: Quantity })
export const IdempotencyKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,128}$/))
export const CommandHeaders = Schema.Struct({ "idempotency-key": Schema.optionalKey(IdempotencyKey) })
export const DeliveryDirection = Schema.Literals(["CompanyToProject", "ProjectToCompany"])
export type DeliveryDirection = typeof DeliveryDirection.Type
export const DeliveryStatus = Schema.Literals(["InTransit", "Delivered", "Rejected", "Cancelled"])
export type DeliveryStatus = typeof DeliveryStatus.Type
export const DeliveryAction = Schema.Literals(["record", "reject", "cancel"])
export type DeliveryAction = typeof DeliveryAction.Type
export const DeliveryLineInput = Schema.Struct({ materialId: Uuid, quantity: PositiveQuantity })
const Lines = Schema.Array(DeliveryLineInput).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
  Schema.makeFilter((lines) => new Set(lines.map((line) => line.materialId.toLowerCase())).size === lines.length, {
    expected: "distinct materials"
  })
)
export const DeliveryInput = Schema.Struct({ lines: Lines })
export const CompanyDeliveryInput = Schema.Struct({ projectId: ProjectId, lines: Lines })
export const DeliveryLine = Schema.Struct({
  material: Schema.Struct({ id: Uuid, name: Schema.String, unit: Schema.String }),
  quantity: PositiveQuantity
})
const Person = Schema.Struct({ id: Uuid, name: Schema.String })
export const Delivery = Schema.Struct({
  id: Uuid,
  project: Schema.Struct({ id: ProjectId, name: Schema.String }),
  direction: DeliveryDirection,
  status: DeliveryStatus,
  lines: Schema.Array(DeliveryLine),
  initiatedAt: Schema.String,
  initiatedBy: Person,
  receivedAt: Schema.NullOr(Schema.String),
  receivedBy: Schema.NullOr(Person),
  closedAt: Schema.NullOr(Schema.String),
  closedBy: Schema.NullOr(Person),
  allowedActions: Schema.Array(DeliveryAction)
})
export type Delivery = typeof Delivery.Type
export const DeliveryQuery = Schema.Struct({
  ...ListQuery.fields,
  direction: Schema.optionalKey(DeliveryDirection),
  status: Schema.optionalKey(DeliveryStatus),
  fromDate: Schema.optionalKey(CalendarDate),
  toDate: Schema.optionalKey(CalendarDate)
}).check(
  Schema.makeFilter(
    (query) => query.fromDate === undefined || query.toDate === undefined || query.fromDate <= query.toDate,
    { expected: "fromDate on or before toDate" }
  )
)
export const CompanyDeliveryQuery = Schema.Struct({
  ...DeliveryQuery.fields,
  projectId: Schema.optionalKey(ProjectId)
}).check(
  Schema.makeFilter(
    (query) => query.fromDate === undefined || query.toDate === undefined || query.fromDate <= query.toDate,
    { expected: "fromDate on or before toDate" }
  )
)
