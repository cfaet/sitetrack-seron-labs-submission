import { NodeRuntime } from "@effect/platform-node"
import { Cause, Effect, Exit, Layer, Logger, Runtime } from "effect"
import { readAuthConfig } from "./config/auth.js"
import { readConfig } from "./config/config.js"
import { readCompanyZone } from "./config/company.js"
import { StartupError } from "./db/migrate.js"
import { serverLayer } from "./server.js"

const main = Effect.gen(function* () {
  const config = yield* readConfig(process.env)
  const auth = yield* readAuthConfig(process.env)
  const zone = yield* readCompanyZone(process.env)
  return yield* Layer.launch(serverLayer(config, undefined, auth, zone))
}).pipe(
  Effect.catchCauseIf(
    (cause) => !Cause.hasInterruptsOnly(cause),
    () =>
      Effect.logError({ event: "startup_failed", message: "Check configuration and database availability." }).pipe(
        Effect.andThen(Effect.fail(new StartupError({ message: "Application startup failed." })))
      )
  ),
  Effect.provide(Logger.layer([Logger.consoleJson]))
)

NodeRuntime.runMain(main, {
  disableErrorReporting: true,
  teardown: (exit, onExit) =>
    Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? onExit(0) : Runtime.defaultTeardown(exit, onExit)
})
