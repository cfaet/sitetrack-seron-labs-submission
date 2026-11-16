import { it } from "@effect/vitest"
import { expect } from "vitest"
import { Data, Effect, Fiber, Logger } from "effect"
import { Migrator, SqlError } from "effect/sql"
import { TestClock } from "effect/testing"
import { databaseStartup } from "../../src/db/startup.js"

class ProbeFailure extends Data.TaggedError("ProbeFailure")<{ readonly message: string }> {}

it.effect("allows startup past the old deadline and cancels at sixty seconds", () =>
  Effect.gen(function* () {
    let cancelled = false
    const fiber = yield* databaseStartup(
      Effect.void,
      Effect.never.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            cancelled = true
          })
        )
      )
    ).pipe(Effect.flip, Effect.forkScoped)
    yield* TestClock.adjust("31 seconds")
    expect(cancelled).toBe(false)
    yield* TestClock.adjust("29 seconds")
    expect(yield* Fiber.join(fiber)).toMatchObject({
      _tag: "StartupError",
      phase: "startup",
      reason: "deadline_exceeded"
    })
    expect(cancelled).toBe(true)
  })
)

it.effect("retries retryable probes but executes a failed migration only once", () =>
  Effect.gen(function* () {
    let probes = 0,
      migrations = 0
    const fiber = yield* databaseStartup(
      Effect.suspend(() =>
        ++probes === 1
          ? Effect.fail(
              new SqlError.SqlError({
                reason: new SqlError.ConnectionError({
                  cause: new Error("PRIVATE_SENTINEL"),
                  message: "PRIVATE_SENTINEL",
                  operation: "connect"
                })
              })
            )
          : Effect.void
      ),
      Effect.suspend(() => {
        migrations++
        return Effect.fail(new Migrator.MigrationError({ kind: "Failed", message: "PRIVATE_SENTINEL" }))
      })
    ).pipe(Effect.flip, Effect.forkScoped)
    yield* TestClock.adjust("250 millis")
    expect(yield* Fiber.join(fiber)).toMatchObject({ phase: "migration", reason: "migration_failure" })
    expect(probes).toBe(2)
    expect(migrations).toBe(1)
  })
)

it.effect("bounds a stalled availability probe without starting migrations", () =>
  Effect.gen(function* () {
    let migrated = false
    const fiber = yield* databaseStartup(
      Effect.never,
      Effect.sync(() => {
        migrated = true
      })
    ).pipe(Effect.flip, Effect.forkScoped)
    yield* TestClock.adjust("60 seconds")
    expect(yield* Fiber.join(fiber)).toMatchObject({ phase: "startup", reason: "deadline_exceeded" })
    expect(migrated).toBe(false)
  })
)

it.effect("distinguishes probe, nested SQL and migration failures without exposing their causes", () =>
  Effect.gen(function* () {
    const captured: Array<unknown> = []
    const logger = Logger.make(({ message }) => {
      captured.push(message)
    })
    const timeout = new SqlError.SqlError({
      reason: new SqlError.StatementTimeoutError({
        message: "PRIVATE_SENTINEL",
        cause: new Error("SELECT PRIVATE_SENTINEL")
      })
    })
    const failures = [
      yield* databaseStartup(Effect.fail(new ProbeFailure({ message: "PRIVATE_SENTINEL" })), Effect.void).pipe(
        Effect.flip,
        Effect.provide(Logger.layer([logger]))
      ),
      yield* databaseStartup(
        Effect.void,
        Effect.fail(new Migrator.MigrationError({ kind: "Failed", message: "PRIVATE_SENTINEL", cause: timeout }))
      ).pipe(Effect.flip, Effect.provide(Logger.layer([logger]))),
      yield* databaseStartup(
        Effect.void,
        Effect.fail(new Migrator.MigrationError({ kind: "Failed", message: "PRIVATE_SENTINEL" }))
      ).pipe(Effect.flip, Effect.provide(Logger.layer([logger])))
    ]
    expect(failures.map(({ phase, reason }) => ({ phase, reason }))).toEqual([
      { phase: "probe", reason: "database_failure" },
      { phase: "migration", reason: "statement_timeout" },
      { phase: "migration", reason: "migration_failure" }
    ])
    expect(captured).toHaveLength(3)
    expect(JSON.stringify({ captured, failures })).not.toMatch(/PRIVATE_SENTINEL|SELECT/)
  })
)
