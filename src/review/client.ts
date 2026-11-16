import { Context, Data, Effect, Layer, Schema } from "effect"
import { ErrorBody } from "../api/common.js"
import { Uuid } from "../domain/models.js"

export class ReviewFailure extends Data.TaggedError("ReviewFailure")<{
  readonly check: string
  readonly message: string
  readonly status?: number
}> {}

export const requireReviewTarget = (env: Readonly<Record<string, string | undefined>>) =>
  env.SITETRACK_REVIEW_ALLOWED === "true" &&
  env.DATABASE_URL === "postgresql://sitetrack:sitetrack_demo_only@db:5432/sitetrack" &&
  env.PORT === "3000"
    ? Effect.void
    : Effect.fail(
        new ReviewFailure({
          check: "target",
          message: "Run inside the isolated reviewer API with explicit demo-write acknowledgement."
        })
      )

const ProjectName = Schema.String.check(Schema.isPattern(/^sitetrack-review-[a-z0-9][a-z0-9-]{0,40}$/))
export const reviewProject = (value: string | undefined) =>
  Schema.decodeUnknownEffect(ProjectName)(value).pipe(
    Effect.mapError(
      () =>
        new ReviewFailure({ check: "target", message: "Supply an isolated sitetrack-review-* Compose project name." })
    )
  )

// This dependency is replaced only in client-boundary unit tests; workflow qualification uses real HTTP.
export class ReviewTransport extends Context.Service<ReviewTransport, typeof fetch>()("sitetrack/ReviewTransport") {
  static readonly layer = Layer.succeed(ReviewTransport, fetch)
}

export interface Account {
  token: string
  cookie: string
  readonly id: string
  readonly email: string
}
export interface RequestOptions {
  readonly actor?: Account
  readonly data?: unknown
  readonly key?: string
  readonly headers?: Readonly<Record<string, string>>
  // Only the OpenAPI document is checked with a partial schema.
  readonly allowExtraFields?: boolean
}
export const verify = (condition: boolean, check: string): Effect.Effect<void, ReviewFailure> =>
  condition ? Effect.void : Effect.fail(new ReviewFailure({ check, message: "Workflow assertion failed." }))

export const reviewRequest = Effect.fn("reviewRequest")(function* (
  check: string,
  method: string,
  path: string,
  expected: number,
  options: RequestOptions = {}
) {
  const transport = yield* ReviewTransport
  // Fixed container-local target, no arbitrary URLs or redirects to a different service.
  yield* verify(path.startsWith("/") && !path.startsWith("//"), "request path")
  const headers: Record<string, string> = { ...options.headers }
  if (options.actor) {
    headers.Authorization = `Bearer ${options.actor.token}`
    headers.Cookie = options.actor.cookie
  }
  if (options.data !== undefined) headers["Content-Type"] = "application/json"
  if (options.key) headers["Idempotency-Key"] = options.key
  const response = yield* Effect.tryPromise(() =>
    transport(`http://127.0.0.1:3000${path}`, {
      method,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(12000),
      ...(options.data === undefined ? {} : { body: JSON.stringify(options.data) })
    })
  ).pipe(
    Effect.mapError(() => new ReviewFailure({ check, message: "HTTP request failed or exceeded twelve seconds." }))
  )
  const requestId = yield* Schema.decodeUnknownEffect(Uuid)(response.headers.get("x-request-id")).pipe(
    Effect.mapError(() => new ReviewFailure({ check, message: "Missing or invalid request ID." }))
  )
  yield* verify(response.status === expected, check).pipe(
    Effect.mapError(
      () =>
        new ReviewFailure({
          check,
          status: response.status,
          message: `Expected HTTP ${expected}.`
        })
    )
  )
  yield* Effect.sync(() =>
    process.stdout.write(JSON.stringify({ event: "workflow_request", check, status: expected, requestId }) + "\n")
  )
  return response
})

export const reviewJson = Effect.fn("reviewJson")(function* <S extends Schema.Constraint>(
  check: string,
  method: string,
  path: string,
  expected: number,
  schema: S,
  options: RequestOptions = {}
) {
  const response = yield* reviewRequest(check, method, path, expected, options)
  const input = yield* Effect.tryPromise(() => response.json()).pipe(
    Effect.mapError(() => new ReviewFailure({ check, message: "Response is not valid JSON." }))
  )
  const body = yield* Schema.decodeUnknownEffect(schema)(input, {
    onExcessProperty: options.allowExtraFields ? "ignore" : "error"
  }).pipe(Effect.mapError(() => new ReviewFailure({ check, message: "Response does not match the API schema." })))
  return { body, headers: response.headers }
})

export const reviewError = Effect.fn("reviewError")(function* (
  check: string,
  method: string,
  path: string,
  expected: number,
  options: RequestOptions = {}
) {
  const result = yield* reviewJson(check, method, path, expected, ErrorBody, options)
  yield* verify(result.body.requestId === result.headers.get("x-request-id"), "error request ID correlation")
  return result.body
})
