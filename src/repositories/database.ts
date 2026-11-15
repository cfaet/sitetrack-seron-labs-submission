import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlError } from "effect/sql"
import { AppError, conflict } from "../domain/errors.js"
export class Database extends Context.Service<Database, SqlClient.SqlClient>()("sitetrack/Database") {
  static readonly layer = Layer.effect(Database, SqlClient.SqlClient)
}
export const rows = <S extends Schema.Constraint>(
  schema: S,
  query: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>
) => query.pipe(Effect.flatMap((data) => Schema.decodeUnknownEffect(Schema.Array(schema))(data).pipe(Effect.orDie)))
export const execute = <A, E, R>(effect: Effect.Effect<A, E | SqlError.SqlError, R>) =>
  effect.pipe(
    Effect.catchIf(SqlError.isSqlError, (error) => {
      if (error.reason._tag === "UniqueViolation")
        return Effect.fail(conflict("ALREADY_EXISTS", "The resource already exists."))
      if (error.isRetryable)
        return Effect.fail(
          new AppError({ status: 503, code: "SERVICE_UNAVAILABLE", message: "Service temporarily unavailable." })
        )
      return Effect.die(error)
    })
  )
export const UserRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  email: Schema.String,
  role: Schema.Literals(["User", "CompanyStoreManager", "SuperAdmin"]),
  createdAt: Schema.String
})
export const page = (query: { readonly page?: number; readonly pageSize?: number }) => ({
  page: query.page ?? 1,
  pageSize: query.pageSize ?? 25,
  offset: ((query.page ?? 1) - 1) * (query.pageSize ?? 25)
})
export const paginated = <A>(
  items: ReadonlyArray<A>,
  total: number,
  input: { readonly page: number; readonly pageSize: number }
) => ({
  items,
  pagination: { page: input.page, pageSize: input.pageSize, total, totalPages: Math.ceil(total / input.pageSize) }
})
