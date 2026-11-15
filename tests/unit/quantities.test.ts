import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { Quantity, PositiveQuantity } from "../../src/domain/inventory-models.js"
import {
  balanceFailure,
  canonicalQuantity,
  formatQuantity,
  maxQuantityUnits,
  quantityUnits,
  stockStatus
} from "../../src/domain/quantities.js"
import { deliveryActions, terminalStatus } from "../../src/domain/inventory.js"

describe("exact inventory quantities", () => {
  it("adds and subtracts fractions without rounding and formats canonical strings", () => {
    expect(formatQuantity(quantityUnits("0.1") + quantityUnits("0.2"))).toBe("0.3")
    expect(formatQuantity(quantityUnits("100") - quantityUnits("0.000001"))).toBe("99.999999")
    expect(canonicalQuantity("00012.340000")).toBe("12.34")
    expect(canonicalQuantity("00000.000000")).toBe("0")
    expect(formatQuantity(-quantityUnits("0.000001"))).toBe("-0.000001")
    expect(formatQuantity(quantityUnits("99999999999999.999999"))).toBe("99999999999999.999999")
    expect(quantityUnits("99999999999999.999999")).toBe(maxQuantityUnits)
    expect(formatQuantity(1_000_000_000_000_000_000_000_000n)).toBe("1000000000000000000")
  })
  it.each(["1e3", "-1", "+1", " 1", "1 ", "NaN", "Infinity", "0.0000001", "100000000000000", ".5", "1."])(
    "rejects invalid amount %s",
    (value) => {
      expect(Schema.is(Quantity)(value)).toBe(false)
    }
  )
  it("distinguishes zero reorder points from positive additions and rejects numeric JSON", () => {
    expect(Schema.is(Quantity)("0")).toBe(true)
    expect(Schema.is(PositiveQuantity)("0")).toBe(false)
    expect(Schema.is(PositiveQuantity)("0.000001")).toBe(true)
    expect(Schema.is(Quantity)(0.1)).toBe(false)
    expect(balanceFailure(-1n)).toBe("INSUFFICIENT_STOCK")
    expect(balanceFailure(maxQuantityUnits + 1n)).toBe("QUANTITY_OVERFLOW")
    expect(balanceFailure(maxQuantityUnits)).toBeUndefined()
  })
  it("round trips generated millionth quantities and conserves arithmetic", () => {
    for (let i = 0n; i < 300n; i++) {
      const amount = (i * 987_654_321_987_654_321n) % maxQuantityUnits
      expect(quantityUnits(formatQuantity(amount))).toBe(amount)
      expect(quantityUnits(formatQuantity(amount + i)) - quantityUnits(formatQuantity(i))).toBe(amount)
    }
  })
  it("prioritizes OutOfStock and includes the reorder boundary in LowStock", () => {
    expect(stockStatus("0", "0")).toBe("OutOfStock")
    expect(stockStatus("0.1", "0.1")).toBe("LowStock")
    expect(stockStatus("0.100001", "0.1")).toBe("Available")
  })
})
describe("delivery actions", () => {
  it("uses store-side authority in both directions and disallows every terminal transition", () => {
    expect(deliveryActions("InTransit", "CompanyToProject", "CompanyStoreManager", false)).toEqual(["cancel"])
    expect(deliveryActions("InTransit", "CompanyToProject", "User", true)).toEqual(["record", "reject"])
    expect(deliveryActions("InTransit", "ProjectToCompany", "User", true)).toEqual(["cancel"])
    expect(deliveryActions("InTransit", "ProjectToCompany", "CompanyStoreManager", false)).toEqual(["record", "reject"])
    expect(deliveryActions("InTransit", "ProjectToCompany", "User", false)).toEqual([])
    expect(deliveryActions("InTransit", "CompanyToProject", "SuperAdmin", false)).toEqual([
      "record",
      "reject",
      "cancel"
    ])
    for (const status of ["Delivered", "Rejected", "Cancelled"] as const)
      expect(deliveryActions(status, "CompanyToProject", "SuperAdmin", true)).toEqual([])
    expect((["record", "reject", "cancel"] as const).map(terminalStatus)).toEqual([
      "Delivered",
      "Rejected",
      "Cancelled"
    ])
  })
})
