import { createServer } from "node:http"
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer, type DateTime } from "effect"
import { HttpRouter } from "effect/http"
import type { Migrator } from "effect/sql"
import { databaseHealthLayer, routes } from "./api/routes.js"
import { applicationRoutes } from "./api/application.js"
import { AuthSettings, type AuthConfig } from "./config/auth.js"
import { CompanyTime, CompanyZone, defaultCompanyZone } from "./config/company.js"
import type { AppConfig } from "./config/config.js"
import { databaseLayer } from "./db/database.js"
import { initializeDatabase, migrations } from "./db/migrate.js"

export const serverLayer = (
  config: AppConfig,
  loader: Migrator.Loader = migrations,
  auth?: AuthConfig,
  zone: DateTime.TimeZone.Named = defaultCompanyZone
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      yield* initializeDatabase(config, loader)
      // This layer (and therefore its socket) is built only after migrations.
      return HttpRouter.serve(
        auth === undefined
          ? routes.pipe(Layer.provide(databaseHealthLayer))
          : applicationRoutes.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(AuthSettings, auth),
                  CompanyTime.layer.pipe(Layer.provide(Layer.succeed(CompanyZone, zone)))
                )
              )
            ),
        {
          disableLogger: true,
          disableListenLog: true
        }
      ).pipe(
        Layer.provide(
          NodeHttpServer.layer(() => createServer({ requestTimeout: 10000, headersTimeout: 10000 }), {
            host: config.host,
            port: config.port,
            gracefulShutdownTimeout: "10 seconds"
          })
        ),
        Layer.tap(() => Effect.logInfo({ event: "listening", host: config.host, port: config.port }))
      )
    })
  ).pipe(Layer.provide(databaseLayer(config)))
