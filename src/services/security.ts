import { randomBytes, timingSafeEqual } from "node:crypto"
import { NodeCrypto } from "@effect/platform-node"
import { Clock, Context, Effect, Layer, Redacted, Schema, Semaphore } from "effect"
import { Kdf, Mac } from "effect/crypto"
import { Jwk, Jwt } from "effect/jose"
import { AuthSettings } from "../config/auth.js"
import { limited, unauthorized } from "../domain/errors.js"

const Hash = Schema.Struct({ algorithm: Schema.Literal("argon2id-v1"), salt: Schema.String, hash: Schema.String })
const makePasswords = Effect.gen(function*() {
  const kdf = yield* Kdf.Kdf
  let outstanding = 0
  const semaphore = yield* Semaphore.make(2)
  const derive = Effect.fn("Passwords.derive")(function*(password: string, salt: Uint8Array) {
    return yield* Effect.acquireUseRelease(
      Effect.suspend(() => outstanding >= 10 ? Effect.fail(limited()) : Effect.sync(() => { outstanding++ })),
      () => semaphore.withPermit(kdf.derive(Kdf.argon2id({ memory: 65536, passes: 3, parallelism: 1 }), new TextEncoder().encode(password), { salt, length: 32 }).pipe(Effect.orDie)),
      () => Effect.sync(() => { outstanding-- })
    )
  })
  const hash = Effect.fn("Passwords.hash")(function*(password: string) {
    const salt = randomBytes(16)
    const bytes = yield* derive(password, salt)
    return JSON.stringify({ algorithm: "argon2id-v1", salt: salt.toString("base64url"), hash: Buffer.from(bytes).toString("base64url") })
  })
  const verify = Effect.fn("Passwords.verify")(function*(password: string, encoded: string) {
    const data = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Hash))(encoded).pipe(Effect.orDie)
    const salt = Buffer.from(data.salt, "base64url"), expected = Buffer.from(data.hash, "base64url")
    if (salt.length !== 16 || expected.length !== 32) return yield* Effect.die(new Error("Invalid stored password hash"))
    const actual = yield* derive(password, salt)
    return timingSafeEqual(actual, expected)
  })
  const dummy = yield* hash(randomBytes(32).toString("base64url"))
  return { hash, verify, dummy }
})
export class Passwords extends Context.Service<Passwords, Effect.Success<typeof makePasswords>>()("sitetrack/Passwords") {
  static readonly layerWithKdf = Layer.effect(Passwords, makePasswords)
  static readonly layer = Passwords.layerWithKdf.pipe(Layer.provide(NodeCrypto.layerKdf))
}
const Claims = Schema.Struct({ sub: Schema.String.check(Schema.isUUID()), sid: Schema.String.check(Schema.isUUID()), purpose: Schema.Literal("access"), iss: Schema.Literal("sitetrack"), aud: Schema.Literal("sitetrack-api"), iat: Schema.Int, exp: Schema.Int, jti: Schema.String.check(Schema.isUUID()) })
const makeTokens = Effect.gen(function*() {
  const config = yield* AuthSettings
  const mac = yield* Mac.Mac
  const key = yield* Jwk.importSecret(Redacted.make({ kty: "oct", k: Redacted.value(config.secret) }), "HS256")
  const sign = Effect.fn("Tokens.sign")(function*(userId: string, sessionId: string, now: number, jti: string) {
    return Redacted.value(yield* Jwt.sign(Claims, { sub: userId, sid: sessionId, purpose: "access", iss: "sitetrack", aud: "sitetrack-api", iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 900, jti }, key, { typ: "at+jwt" }).pipe(Effect.provideService(Mac.Mac, mac), Effect.orDie))
  })
  const verify = Effect.fn("Tokens.verify")(function*(token: string) {
    if (token.length > 8192) return yield* unauthorized()
    return (yield* Jwt.verify(Claims, token, key, { issuer: "sitetrack", audience: "sitetrack-api", typ: "at+jwt", maxTokenAge: "15 minutes", requiredClaims: ["sub", "iss", "aud", "iat", "exp", "jti"] }).pipe(Effect.provideService(Mac.Mac, mac), Effect.mapError(unauthorized))).claims
  })
  return { sign, verify }
})
export class Tokens extends Context.Service<Tokens, Effect.Success<typeof makeTokens>>()("sitetrack/Tokens") {
  static readonly layer = Layer.effect(Tokens, makeTokens).pipe(Layer.provide(NodeCrypto.layerMac))
}
const makeThrottle = Effect.gen(function*() {
  const buckets = new Map<string, { count: number; until: number }>()
  const admit = Effect.fn("Throttle.admit")(function*(kind: "login" | "register", ip: string) {
    const now = yield* Clock.currentTimeMillis
    for (const [key, value] of buckets) if (value.until <= now) buckets.delete(key)
    const consume = (key: string, limit: number, duration: number) => {
      const value = buckets.get(key) ?? { count: 0, until: now + duration }
      if (value.count >= limit) return Math.max(1, Math.ceil((value.until - now) / 1000))
      buckets.set(key, { count: value.count + 1, until: value.until })
      return 0
    }
    const global = consume(`${kind}:global`, kind === "login" ? 120 : 30, 60000)
    if (global) return yield* limited(global)
    const local = consume(`${kind}:${ip}`, kind === "login" ? 20 : 5, kind === "login" ? 300000 : 60000)
    if (local) return yield* limited(local)
  })
  return { admit }
})
export class Throttle extends Context.Service<Throttle, Effect.Success<typeof makeThrottle>>()("sitetrack/Throttle") {
  static readonly layer = Layer.effect(Throttle, makeThrottle)
}
