const scale = 1_000_000n
export const maxQuantityUnits = 99_999_999_999_999_999_999n
const decimal = /^\d+(?:\.\d{1,6})?$/
const stored = /^\d{1,14}(?:\.\d{1,6})?$/

// Only validated plain decimals reach arithmetic. No rounding or floating-point conversion.
export const quantityUnits = (value: string): bigint => {
  if (!decimal.test(value)) throw new Error("Invalid internal decimal quantity")
  const [whole, fraction = ""] = value.split(".")
  if (whole === undefined) throw new Error("Missing internal quantity")
  return BigInt(whole) * scale + BigInt(fraction.padEnd(6, "0"))
}
export const isQuantity = (value: string) => stored.test(value) && quantityUnits(value) <= maxQuantityUnits
export const isDecimal = (value: string) => decimal.test(value)
export const formatQuantity = (value: bigint): string => {
  const negative = value < 0n,
    absolute = negative ? -value : value
  const fraction = (absolute % scale).toString().padStart(6, "0").replace(/0+$/, "")
  return `${negative ? "-" : ""}${absolute / scale}${fraction === "" ? "" : `.${fraction}`}`
}
export const canonicalQuantity = (value: string) => formatQuantity(quantityUnits(value))
export const balanceFailure = (value: bigint) =>
  value < 0n ? "INSUFFICIENT_STOCK" : value > maxQuantityUnits ? "QUANTITY_OVERFLOW" : undefined
export const stockStatus = (quantity: string, reorderPoint: string) =>
  quantityUnits(quantity) === 0n
    ? "OutOfStock"
    : quantityUnits(quantity) <= quantityUnits(reorderPoint)
      ? "LowStock"
      : "Available"
