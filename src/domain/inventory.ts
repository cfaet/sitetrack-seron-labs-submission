import type { Role } from "./models.js"
import type { DeliveryAction, DeliveryDirection, DeliveryStatus } from "./inventory-models.js"

export const canUseCompanyStore = (role: typeof Role.Type) => role === "SuperAdmin" || role === "CompanyStoreManager"
export const deliveryActions = (
  status: DeliveryStatus,
  direction: DeliveryDirection,
  role: typeof Role.Type,
  member: boolean
): ReadonlyArray<DeliveryAction> => {
  if (status !== "InTransit") return []
  const company = canUseCompanyStore(role),
    project = role === "SuperAdmin" || member
  const destination = direction === "CompanyToProject" ? project : company
  const source = direction === "CompanyToProject" ? company : project
  return [...(destination ? (["record", "reject"] as const) : []), ...(source ? (["cancel"] as const) : [])]
}
export const terminalStatus = (action: DeliveryAction): DeliveryStatus =>
  action === "record" ? "Delivered" : action === "reject" ? "Rejected" : "Cancelled"
