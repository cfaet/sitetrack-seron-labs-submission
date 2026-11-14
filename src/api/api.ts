import { Context, Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"

export class RequestId extends Context.Service<RequestId, string>()("sitetrack/RequestId") {}

export const ErrorBody = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  requestId: Schema.String
})

export const Unavailable = ErrorBody.annotate({ httpApiStatus: 503 })
const InternalError = ErrorBody.annotate({ httpApiStatus: 500 })

export class Api extends HttpApi.make("SiteTrack").add(
  HttpApiGroup.make("health").add(
    HttpApiEndpoint.get("live", "/health/live", {
      success: Schema.Struct({ status: Schema.Literal("ok") }),
      error: InternalError
    }),
    HttpApiEndpoint.get("ready", "/health/ready", {
      success: Schema.Struct({ status: Schema.Literal("ready") }),
      error: [Unavailable, InternalError]
    })
  )
) {}
