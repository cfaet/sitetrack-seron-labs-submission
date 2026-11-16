import { spawnSync } from "node:child_process"
import { NodeRuntime } from "@effect/platform-node"
import { Effect, Logger } from "effect"
import { reviewProject, ReviewFailure } from "./client.js"

const main = Effect.gen(function* () {
  const project = yield* reviewProject(process.argv[2])
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith("COMPOSE_") || key.startsWith("DOCKER_") || key === "BUILDX_BUILDER") delete env[key]
  }
  const result = yield* Effect.try(() =>
    spawnSync(
      "docker",
      [
        "--host",
        "unix:///var/run/docker.sock",
        "compose",
        "--env-file",
        "/dev/null",
        "--project-name",
        project,
        "-f",
        "compose.yaml",
        "exec",
        "-T",
        "-e",
        "SITETRACK_REVIEW_ALLOWED=true",
        "api",
        "node",
        "dist/review/cli.js"
      ],
      { env, stdio: "inherit", timeout: 195000 }
    )
  ).pipe(
    Effect.mapError(() => new ReviewFailure({ check: "compose", message: "Could not execute the reviewer workflow." }))
  )
  if (result.error || result.status !== 0)
    return yield* new ReviewFailure({
      check: "compose",
      message: "Reviewer workflow failed; inspect its safe progress output."
    })
}).pipe(
  Effect.tapError((error) =>
    Effect.sync(() =>
      process.stderr.write(
        JSON.stringify({ event: "workflow_failed", check: error.check, message: error.message }) + "\n"
      )
    )
  ),
  Effect.provide(Logger.layer([]))
)
NodeRuntime.runMain(main, { disableErrorReporting: true })
