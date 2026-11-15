import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import type { Actor } from "../domain/models.js"
import { conflict } from "../domain/errors.js"
import { Database, rows } from "../repositories/database.js"

// Caller owns the transaction and session lock. This lock precedes all inventory row locks.
export const idempotent = <S extends Schema.Constraint, E, R, E2, R2>(
  actor: Actor,
  operation: string,
  key: string | undefined,
  normalized: unknown,
  schema: S,
  status: 200 | 201,
  authorize: Effect.Effect<Actor, E2, R2>,
  run: (current: Actor) => Effect.Effect<S["Type"], E, R>
) =>
  Effect.gen(function* () {
    const sql = yield* Database
    const fingerprint = createHash("sha256").update(JSON.stringify(normalized)).digest("hex")
    if (key !== undefined)
      yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["sitetrack:idempotency", actor.user.id, operation, key])},0))`
    const current = yield* authorize
    if (key !== undefined) {
      const found = yield* rows(
        Schema.Struct({ fingerprint: Schema.String, response: Schema.Unknown, status: Schema.Literals([200, 201]) }),
        sql`SELECT fingerprint,response,response_status AS status FROM idempotency_records WHERE actor_id=${actor.user.id} AND operation=${operation} AND key=${key}`
      )
      const saved = found[0]
      if (saved !== undefined) {
        if (saved.fingerprint !== fingerprint)
          return yield* conflict("IDEMPOTENCY_CONFLICT", "This key was used for a different request.")
        if (saved.status !== status) return yield* Effect.die(new Error("Stored idempotency status mismatch"))
        const responses = yield* rows(schema, Effect.succeed([saved.response]))
        const response = responses[0]
        if (response === undefined) return yield* Effect.die(new Error("Missing decoded idempotency response"))
        return response
      }
    }
    const response = yield* run(current)
    if (key !== undefined) {
      const encoded = yield* Schema.encodeEffect(schema)(response).pipe(Effect.orDie)
      yield* sql`INSERT INTO idempotency_records(actor_id,operation,key,fingerprint,response_status,response)
      VALUES (${actor.user.id},${operation},${key},${fingerprint},${status},${JSON.stringify(encoded)}::jsonb)`
    }
    return response
  })
