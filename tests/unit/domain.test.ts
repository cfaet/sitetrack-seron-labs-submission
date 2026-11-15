import { describe, expect, it } from "vitest"
import { Effect, Layer, Redacted, Schema } from "effect"
import { isCalendarDate, Password, ProjectInput, publicProjectId } from "../../src/domain/models.js"
import { readAuthConfig, AuthSettings } from "../../src/config/auth.js"
import { Passwords, Tokens, Throttle } from "../../src/services/security.js"
const key = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc"
describe("Stage 2 pure input rules", () => {
  it.each(["2024-02-29", "2000-02-29", "2026-12-31", "0001-01-01"])("accepts calendar date %s", (value) =>
    expect(isCalendarDate(value)).toBe(true)
  )
  it.each(["2025-02-29", "1900-02-29", "2026-04-31", "0000-01-01", "2026-1-01", "2026-13-01"])(
    "rejects calendar date %s",
    (value) => expect(isCalendarDate(value)).toBe(false)
  )
  it("counts password Unicode characters without normalizing their value", () => {
    expect(() => Schema.decodeSync(Password)("😀".repeat(8))).toThrow()
    expect(Schema.decodeSync(Password)("😀".repeat(15))).toBe("😀".repeat(15))
  })
  it("rejects inverted ranges and preserves wide project IDs", () => {
    expect(() =>
      Schema.decodeSync(ProjectInput)({ name: "Site", startDate: "2026-12-01", endDate: "2026-01-01" })
    ).toThrow()
    expect(publicProjectId("1")).toBe("PRJ-0001")
    expect(publicProjectId("10000")).toBe("PRJ-10000")
  })
  it("requires private signing material and validates origins without exposing inputs", async () => {
    for (const env of [
      {},
      { AUTH_JWT_SECRET: "not-a-valid-private-value" },
      { AUTH_JWT_SECRET: key, AUTH_ALLOWED_ORIGINS: "*" },
      { AUTH_JWT_SECRET: key, AUTH_ALLOWED_ORIGINS: "http://localhost/path" },
      { AUTH_JWT_SECRET: key, AUTH_COOKIE_SECURE: "yes" }
    ]) {
      const error = await Effect.runPromise(readAuthConfig(env).pipe(Effect.flip))
      expect(error._tag).toBe("ConfigurationError")
      expect(JSON.stringify(error)).not.toContain("not-a-valid-private-value")
    }
    const config = await Effect.runPromise(readAuthConfig({ AUTH_JWT_SECRET: key }))
    expect(config.secureCookie).toBe(true)
    expect(JSON.stringify(config)).not.toContain(key)
  })
})
describe("real security primitives", () => {
  it("hashes with distinct salts and verifies only matching passwords", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const passwords = yield* Passwords
        const a = yield* passwords.hash("A synthetic password!"),
          b = yield* passwords.hash("A synthetic password!")
        expect(a).not.toBe(b)
        expect(a).not.toContain("synthetic")
        expect(yield* passwords.verify("A synthetic password!", a)).toBe(true)
        expect(yield* passwords.verify("A wrong password!", a)).toBe(false)
      }).pipe(Effect.provide(Passwords.layer))
    )
  })
  it("signs and validates claim policy and rejects tampering/old tokens", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const tokens = yield* Tokens,
          now = Date.now()
        const token = yield* tokens.sign(
          "00000000-0000-4000-8000-000000000001",
          "00000000-0000-4000-8000-000000000002",
          now,
          "00000000-0000-4000-8000-000000000003"
        )
        expect((yield* tokens.verify(token)).purpose).toBe("access")
        expect((yield* tokens.verify(`${token.slice(0, -10)}aaaaaaaaaa`).pipe(Effect.flip)).status).toBe(401)
        const expired = yield* tokens.sign(
          "00000000-0000-4000-8000-000000000001",
          "00000000-0000-4000-8000-000000000002",
          now - 1000000,
          "00000000-0000-4000-8000-000000000003"
        )
        expect((yield* tokens.verify(expired).pipe(Effect.flip)).status).toBe(401)
      }).pipe(
        Effect.provide(
          Tokens.layer.pipe(
            Layer.provide(Layer.succeed(AuthSettings, { secret: Redacted.make(key), secureCookie: true, origins: [] }))
          )
        )
      )
    )
  })
  it("bounds auth admission without trusting arbitrary identity keys", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const throttle = yield* Throttle
        for (let i = 0; i < 5; i++) yield* throttle.admit("register", "test-ip")
        expect((yield* throttle.admit("register", "test-ip").pipe(Effect.flip)).status).toBe(429)
      }).pipe(Effect.provide(Throttle.layer))
    )
  })
})
