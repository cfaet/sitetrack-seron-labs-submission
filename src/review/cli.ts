import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Logger } from "effect"
import { ReviewTransport } from "./client.js"
import { workflows } from "./workflows.js"

NodeRuntime.runMain(
  workflows(process.env).pipe(
    Effect.timeout("3 minutes"),
    Effect.tap((report) => Effect.sync(() => process.stdout.write(JSON.stringify(report) + "\n"))),
    Effect.tapError((error) =>
      Effect.sync(() =>
        process.stderr.write(
          JSON.stringify({
            event: "workflow_failed",
            ...(error._tag === "ReviewFailure"
              ? { check: error.check, message: error.message, status: error.status }
              : { message: "Workflow exceeded three minutes." })
          }) + "\n"
        )
      )
    ),
    Effect.provide(Layer.mergeAll(ReviewTransport.layer, Logger.layer([])))
  ),
  { disableErrorReporting: true }
)
