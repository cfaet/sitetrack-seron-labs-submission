import { Data, Effect, Schedule } from "effect"
import { Migrator, SqlError } from "effect/sql"

export class StartupError extends Data.TaggedError("StartupError")<{
  readonly message: string
  readonly phase: "probe" | "migration" | "startup" | "application"
  readonly reason:
    | "connection_failure"
    | "statement_timeout"
    | "lock_timeout"
    | "migration_failure"
    | "database_failure"
    | "deadline_exceeded"
    | "startup_failure"
}> {}

const failureReason = (error: unknown): StartupError["reason"] => {
  // Migrator wraps statement failures. Inspect only known wrappers and fixed tags.
  const underlying = error instanceof Migrator.MigrationError ? error.cause : error
  if (SqlError.isSqlError(underlying)) {
    switch (underlying.reason._tag) {
      case "ConnectionError":
        return "connection_failure"
      case "StatementTimeoutError":
        return "statement_timeout"
      case "LockTimeoutError":
        return "lock_timeout"
    }
  }
  return error instanceof Migrator.MigrationError ? "migration_failure" : "database_failure"
}

export const databaseStartup = Effect.fn("databaseStartup")(
  <A, E, R, E2, R2>(probe: Effect.Effect<A, E, R>, migration: Effect.Effect<unknown, E2, R2>) =>
    probe.pipe(
      // Availability probes may retry; a migration is executed once, transactionally.
      Effect.retry({
        schedule: Schedule.spaced("250 millis"),
        while: (error) => SqlError.isSqlError(error) && error.isRetryable
      }),
      Effect.mapError(
        (error) =>
          new StartupError({
            message: "Database availability check failed.",
            phase: "probe",
            reason: failureReason(error)
          })
      ),
      Effect.andThen(
        migration.pipe(
          Effect.mapError(
            (error) =>
              new StartupError({
                message: "Database migration failed.",
                phase: "migration",
                reason: failureReason(error)
              })
          )
        )
      ),
      Effect.asVoid,
      Effect.timeoutOrElse({
        duration: "60 seconds",
        orElse: () =>
          Effect.fail(
            new StartupError({
              message: "Database startup exceeded 60 seconds.",
              phase: "startup",
              reason: "deadline_exceeded"
            })
          )
      }),
      Effect.tapError((error) =>
        Effect.logError({
          event: "database_startup_failed",
          phase: error.phase,
          reason: error.reason,
          message: error.message
        })
      )
    )
)
