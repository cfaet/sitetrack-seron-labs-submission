import { Effect, Schema } from "effect"
import type { SqlClient, SqlError } from "effect/sql"

// Hold a real row/table lock until both independent requests are waiting in PG.
export const race = async (
  sql: SqlClient.SqlClient,
  lock: Effect.Effect<unknown, SqlError.SqlError>,
  requests: () => ReadonlyArray<Promise<Response>>
) => {
  let entered: () => void = () => {
    throw new Error("Race entry not initialized")
  }
  let release: () => void = () => {
    throw new Error("Race release not initialized")
  }
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const holder = Effect.runPromise(
    sql.withTransaction(
      Effect.gen(function* () {
        yield* lock
        entered()
        yield* Effect.promise(() => released)
      })
    )
  )
  try {
    await Promise.race([ready, holder])
    const pending = requests()
    let blocked = false
    for (let i = 0; i < 100; i++) {
      const found = await Effect.runPromise(
        sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=current_setting('application_name') AND wait_event_type='Lock' AND pid<>pg_backend_pid()`
      )
      const counts = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ count: Schema.Int })))(found)
      if ((counts[0]?.count ?? 0) >= 2) {
        blocked = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    release()
    const responses = await Promise.all(pending)
    if (!blocked) throw new Error("Race did not establish two overlapping blocked database connections")
    return responses
  } finally {
    release()
    await holder
  }
}
