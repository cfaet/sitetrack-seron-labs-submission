import { Context, Effect, Schema } from "effect"
import { HttpServerResponse } from "effect/http"
import { AppError } from "../domain/errors.js"
export class RequestId extends Context.Service<RequestId, string>()("sitetrack/RequestId") {}
export const ErrorBody = Schema.Struct({ code: Schema.String, message: Schema.String, requestId: Schema.String })
export const errors = [400,401,403,404,409,413,429,500,503].map((status) => ErrorBody.annotate({ httpApiStatus: status }))
export const errorResponseFor = Effect.fn("errorResponseFor")(function*(error: AppError, requestId: string) {
  const encoded = yield* Schema.encodeEffect(ErrorBody)({ code: error.code, message: error.message, requestId }).pipe(Effect.orDie)
  const response = yield* HttpServerResponse.json(encoded, { status: error.status }).pipe(Effect.orDie)
  return error.retryAfter === undefined ? response : HttpServerResponse.setHeader(response, "Retry-After", String(error.retryAfter))
})
export const jsonResponse = <S extends Schema.Constraint>(schema: S, value: S["Type"], status = 200) => Schema.encodeEffect(schema)(value).pipe(Effect.orDie, Effect.flatMap((encoded) => HttpServerResponse.json(encoded, { status }).pipe(Effect.orDie)))

export const errorResponse = (error: AppError) => Effect.flatMap(RequestId, (id) => errorResponseFor(error, id))
