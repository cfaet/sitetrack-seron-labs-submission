import { NodeRuntime } from "@effect/platform-node"
import { Cause, Effect, Logger } from "effect"
import { ConfigurationError, readConfig, readTestConfig } from "../config/config.js"
import { databaseLayer } from "./database.js"
import { assertTestDatabase, inspectDatabase } from "./inspect.js"
import { initializeDatabase } from "./migrate.js"

const main = Effect.gen(function* () {
  const command = process.argv[2]
  if (command !== "check" && command !== "test-check" && command !== "migrate") {
    return yield* new ConfigurationError({ message: "Expected check, test-check or migrate." })
  }
  const config = yield* command === "test-check" ? readTestConfig(process.env) : readConfig(process.env)
  yield* Effect.gen(function* () {
    if (command === "test-check") yield* assertTestDatabase
    if (command === "migrate") yield* initializeDatabase(config)
    yield* Effect.logInfo(yield* inspectDatabase(config))
  }).pipe(Effect.timeout("30 seconds"), Effect.provide(databaseLayer(config)))
}).pipe(
  Effect.catchCauseIf(
    (cause) => !Cause.hasInterruptsOnly(cause),
    () =>
      Effect.fail(
        new ConfigurationError({
          message: "Database command failed. Check explicit configuration, credentials and database availability."
        })
      ).pipe(Effect.tapError((error) => Effect.logError({ event: "database_command_failed", message: error.message })))
  ),
  Effect.provide(Logger.layer([Logger.consoleJson]))
)

NodeRuntime.runMain(main, { disableErrorReporting: true })
