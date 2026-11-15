import { ByteSize, Effect, Schema } from "effect"
import { HttpIncomingMessage, HttpServerRequest } from "effect/http"
import { AppError, invalid } from "../domain/errors.js"
import { errorResponse } from "./common.js"

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)
export const readInput = <S extends Schema.Constraint>(schema: S, request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    if (!(request.headers["content-type"] ?? "").match(/^application\/json(?:\s*;|$)/i)) return yield* invalid()
    const value = yield* request.json.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(16)),
      Effect.mapError((error) =>
        error.reason._tag === "RequestParseError" && error.reason.reason === "BodyTooLarge"
          ? new AppError({ status: 413, code: "PAYLOAD_TOO_LARGE", message: "Request body is too large." })
          : invalid()
      )
    )
    const normalized = isJsonObject(value) ? Object.fromEntries(Object.entries(value)) : value
    // Normalize only the declared non-secret identity/catalogue fields; preserve passwords exactly.
    if (typeof normalized === "object" && normalized !== null) {
      if ("email" in normalized && typeof normalized.email === "string")
        normalized.email = normalized.email.trim().toLowerCase()
      if ("name" in normalized && typeof normalized.name === "string") normalized.name = normalized.name.trim()
      if ("category" in normalized && typeof normalized.category === "string")
        normalized.category = normalized.category.trim()
      if ("unit" in normalized && typeof normalized.unit === "string") normalized.unit = normalized.unit.trim()
    }
    // The generic Encoded constraint is unknown; JSON is not yet validated against the caller's schema.
    // oxlint-disable-next-line effecttsgo/prefer-typed-schema-decoder
    return yield* Schema.decodeUnknownEffect(schema)(normalized, { onExcessProperty: "error" }).pipe(
      Effect.mapError(invalid)
    )
  })
export const guarded = <A, E, R>(effect: Effect.Effect<A, E | AppError, R>) =>
  effect.pipe(Effect.catchIf((error): error is AppError => error instanceof AppError, errorResponse))
