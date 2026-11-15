import { Data, Effect, Redacted, Schema } from "effect"

export class ConfigurationError extends Data.TaggedError("ConfigurationError")<{
  readonly message: string
}> {}

const SchemaName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,62}$/))
const Settings = Schema.Struct({
  databaseUrl: Schema.NonEmptyString,
  schema: SchemaName,
  host: Schema.NonEmptyString,
  port: Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 65535 }))
})

export interface AppConfig {
  readonly databaseUrl: Redacted.Redacted<string>
  readonly schema: string
  readonly host: string
  readonly port: number
}

export const readConfig = Effect.fn("readConfig")(function* (env: Readonly<Record<string, string | undefined>>) {
  const settings = yield* Schema.decodeUnknownEffect(Settings)({
    databaseUrl: env.DATABASE_URL,
    schema: env.DATABASE_SCHEMA ?? "sitetrack",
    host: env.HOST ?? "0.0.0.0",
    port: env.PORT ?? "3000"
  }).pipe(
    Effect.mapError(
      () =>
        new ConfigurationError({
          message: "Invalid configuration: check DATABASE_URL, DATABASE_SCHEMA, HOST and PORT."
        })
    )
  )
  yield* Effect.try({
    try: () => {
      const url = new URL(settings.databaseUrl)
      if (
        !(url.protocol === "postgres:" || url.protocol === "postgresql:") ||
        url.hostname.length === 0 ||
        url.username.length === 0 ||
        url.pathname.length <= 1 ||
        url.search.length > 0 ||
        url.hash.length > 0
      ) {
        throw new Error("Invalid database URL")
      }
    },
    catch: () =>
      new ConfigurationError({
        message: "DATABASE_URL must specify PostgreSQL host, role and database, without query parameters."
      })
  })
  return Object.freeze({
    ...settings,
    databaseUrl: Redacted.make(settings.databaseUrl)
  }) satisfies AppConfig
})

export const readTestConfig = Effect.fn("readTestConfig")(function* (
  env: Readonly<Record<string, string | undefined>>
) {
  if (env.SITETRACK_TEST_DISPOSABLE !== "true" || env.TEST_DATABASE_URL === undefined) {
    return yield* new ConfigurationError({
      message: "Tests require TEST_DATABASE_URL and SITETRACK_TEST_DISPOSABLE=true; no development fallback is allowed."
    })
  }
  const config = yield* readConfig({ DATABASE_URL: env.TEST_DATABASE_URL })
  const url = new URL(Redacted.value(config.databaseUrl))
  if (url.pathname !== "/sitetrack_test" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    return yield* new ConfigurationError({
      message: "Integration tests require the approved local sitetrack_test database."
    })
  }
  return config
})
