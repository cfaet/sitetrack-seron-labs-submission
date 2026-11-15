import { describe, expect, it } from "vitest"
import { DateTime, Effect } from "effect"
import { companyInstant, defaultCompanyZone, readCompanyZone } from "../../src/config/company.js"

describe("company calendar configuration", () => {
  it("defaults to Muscat and changes date at company midnight, not UTC midnight", async () => {
    const zone = await Effect.runPromise(readCompanyZone({}))
    expect(DateTime.zoneToString(zone)).toBe("Asia/Muscat")
    expect(companyInstant(DateTime.makeUnsafe("2026-11-14T19:59:59.999Z"), zone).today).toBe("2026-11-14")
    expect(companyInstant(DateTime.makeUnsafe("2026-11-14T20:00:00.000Z"), zone).today).toBe("2026-11-15")
    expect(companyInstant(DateTime.makeUnsafe("2026-11-14T20:00:00.000Z"), defaultCompanyZone).instant).toBe(
      "2026-11-14T20:00:00.000Z"
    )
  })
  it("supports named zones with daylight-saving changes and rejects invalid configuration", async () => {
    const zone = await Effect.runPromise(readCompanyZone({ COMPANY_TIME_ZONE: "America/New_York" }))
    expect(companyInstant(DateTime.makeUnsafe("2026-07-01T04:00:00Z"), zone).today).toBe("2026-07-01")
    expect(companyInstant(DateTime.makeUnsafe("2026-01-01T04:00:00Z"), zone).today).toBe("2025-12-31")
    for (const name of ["", "not/a-zone", "+04:00"]) {
      const failure = await Effect.runPromise(readCompanyZone({ COMPANY_TIME_ZONE: name }).pipe(Effect.flip))
      expect(failure._tag).toBe("ConfigurationError")
    }
  })
})
