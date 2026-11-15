import { Context, Effect, Redacted, Schema } from "effect"
import { ConfigurationError } from "./config.js"
export interface AuthConfig {
  readonly secret: Redacted.Redacted<string>
  readonly secureCookie: boolean
  readonly origins: ReadonlyArray<string>
}
export class AuthSettings extends Context.Service<AuthSettings, AuthConfig>()("sitetrack/AuthSettings") {}
export const readAuthConfig = Effect.fn("readAuthConfig")(function* (
  env: Readonly<Record<string, string | undefined>>
) {
  const decoded = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      secret: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43,}$/)),
      secure: Schema.optionalKey(Schema.Literals(["true", "false"]))
    })
  )({ secret: env.AUTH_JWT_SECRET, secure: env.AUTH_COOKIE_SECURE ?? "true" }).pipe(
    Effect.mapError(() => new ConfigurationError({ message: "Check AUTH_JWT_SECRET and AUTH_COOKIE_SECURE." }))
  )
  const bytes = Buffer.from(decoded.secret, "base64url")
  const origins = (env.AUTH_ALLOWED_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:3000")
    .split(",")
    .map((origin) => origin.trim())
  if (
    bytes.length < 32 ||
    bytes.toString("base64url") !== decoded.secret ||
    origins.length === 0 ||
    origins.some((origin) => {
      try {
        const url = new URL(origin)
        return !["http:", "https:"].includes(url.protocol) || url.origin !== origin
      } catch {
        return true
      }
    })
  )
    return yield* new ConfigurationError({
      message: "Auth configuration requires a canonical 32-byte-or-longer key and explicit HTTP origins."
    })
  return Object.freeze({
    secret: Redacted.make(decoded.secret),
    secureCookie: decoded.secure !== "false",
    origins: Object.freeze(origins)
  }) satisfies AuthConfig
})
