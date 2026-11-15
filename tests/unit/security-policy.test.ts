import { createHmac, randomUUID } from "node:crypto"
import { it } from "@effect/vitest"
import { expect } from "vitest"
import { Clock, Deferred, Effect, Fiber, Layer, Redacted, Result } from "effect"
import { TestClock } from "effect/testing"
import { AuthSettings } from "../../src/config/auth.js"
import { Kdf } from "effect/crypto"
import { Passwords, Throttle, Tokens } from "../../src/services/security.js"
const secret = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc"
it.effect("resets throttling windows using the injected clock", () => Effect.gen(function*() {
  const throttle = yield* Throttle
  for (let i = 0; i < 20; i++) yield* throttle.admit("login", "one-client")
  expect((yield* throttle.admit("login", "one-client").pipe(Effect.flip)).status).toBe(429)
  yield* TestClock.adjust("5 minutes")
  yield* throttle.admit("login", "one-client")
}).pipe(Effect.provide(Throttle.layer)))
it.effect("checks signed JWT issuer, audience, purpose, required claims and algorithm", () => Effect.gen(function*() {
  const tokens = yield* Tokens
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)
  const base = { sub: randomUUID(), sid: randomUUID(), jti: randomUUID(), iss: "sitetrack", aud: "sitetrack-api", purpose: "access", iat: now, exp: now + 900 }
  const signed = (claims: object, algorithm = "HS256") => {
    const header = Buffer.from(JSON.stringify({ alg: algorithm, typ: "at+jwt" })).toString("base64url")
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
    return `${header}.${payload}.${createHmac("sha256", Buffer.from(secret, "base64url")).update(`${header}.${payload}`).digest("base64url")}`
  }
  for (const claims of [{ ...base, iss: "other" }, { ...base, aud: "other" }, { ...base, purpose: "refresh" }, { ...base, exp: now }, { ...base, nbf: now + 10 }, { ...base, exp: undefined }]) {
    expect((yield* tokens.verify(signed(claims)).pipe(Effect.flip)).status).toBe(401)
  }
  expect((yield* tokens.verify(signed(base, "none")).pipe(Effect.flip)).status).toBe(401)
  expect((yield* tokens.verify(signed(base))).sid).toBe(base.sid)
  yield* TestClock.adjust("15 minutes")
  expect((yield* tokens.verify(signed(base)).pipe(Effect.flip)).status).toBe(401)
}).pipe(Effect.provide(Tokens.layer), Effect.provide(Layer.succeed(AuthSettings, { secret: Redacted.make(secret), secureCookie: true, origins: [] }))))

it.effect("admits only two active and eight waiting password derivations", () => Effect.gen(function*() {
  const release = yield* Deferred.make<void>()
  const overflow = yield* Deferred.make<void>()
  let calls = 0, active = 0, maximum = 0
  const kdf = Kdf.Kdf.of({ derive: () => Effect.suspend(() => {
    calls++
    if (calls === 1) return Effect.succeed(new Uint8Array(32)) // startup dummy hash
    active++; maximum = Math.max(maximum, active)
    return Deferred.await(release).pipe(Effect.as(new Uint8Array(32)), Effect.ensuring(Effect.sync(() => { active-- })))
  }) })
  yield* Effect.gen(function*() {
    const passwords = yield* Passwords
    const work = yield* Effect.forEach(Array.from({ length: 11 }), () => passwords.hash("Synthetic workload password").pipe(
      Effect.result, Effect.tap((result) => Result.isFailure(result) ? Deferred.succeed(overflow, undefined) : Effect.void)
    ), { concurrency: "unbounded" }).pipe(Effect.forkScoped)
    yield* Deferred.await(overflow)
    expect(active).toBe(2)
    yield* Deferred.succeed(release, undefined)
    const results = yield* Fiber.join(work)
    expect(results.filter(Result.isFailure)).toHaveLength(1)
    expect(maximum).toBe(2)
  }).pipe(Effect.provide(Passwords.layerWithKdf), Effect.provide(Layer.succeed(Kdf.Kdf, kdf)))
}))
