import { it } from "@effect/vitest"
import { expect } from "vitest"
import { Effect, Schema } from "effect"
import { ReviewTransport, reviewJson, reviewProject, reviewRequest } from "../../src/review/client.js"
import { workflows } from "../../src/review/workflows.js"

const demo = {
  SITETRACK_REVIEW_ALLOWED: "true",
  DATABASE_URL: "postgresql://sitetrack:sitetrack_demo_only@db:5432/sitetrack",
  PORT: "3000"
}
const requestId = "00000000-0000-4000-8000-000000000001"

it.effect("rejects missing acknowledgement, native and remote targets before any HTTP request", () =>
  Effect.gen(function* () {
    let calls = 0
    const transport: typeof fetch = async () => {
      calls++
      return new Response()
    }
    for (const env of [
      {},
      { ...demo, SITETRACK_REVIEW_ALLOWED: "false" },
      { ...demo, DATABASE_URL: "postgresql://PRIVATE_SENTINEL@localhost/private" },
      { ...demo, DATABASE_URL: "postgresql://PRIVATE_SENTINEL@example.test/private" },
      { ...demo, PORT: "3001" }
    ]) {
      const failure = yield* workflows(env).pipe(Effect.flip, Effect.provideService(ReviewTransport, transport))
      expect(failure.check).toBe("target")
      expect(JSON.stringify(failure)).not.toContain("PRIVATE_SENTINEL")
    }
    expect(calls).toBe(0)
  })
)

it.effect("rejects default/benchmark project names without echoing invalid input", () =>
  Effect.gen(function* () {
    for (const name of [
      undefined,
      "sitetrack",
      "sitetrack-scale-large-verified",
      "PRIVATE_SENTINEL",
      "sitetrack-review-../private"
    ]) {
      expect(JSON.stringify(yield* reviewProject(name).pipe(Effect.flip))).not.toContain("PRIVATE_SENTINEL")
    }
    expect(yield* reviewProject("sitetrack-review-20261116")).toBe("sitetrack-review-20261116")
  })
)

it.effect("uses bounded container-local HTTP and reports failures without private response bodies", () =>
  Effect.gen(function* () {
    const transport: typeof fetch = async (url, options) => {
      expect(url).toBe("http://127.0.0.1:3000/health/ready")
      expect(options?.redirect).toBe("error")
      expect(options?.signal).toBeInstanceOf(AbortSignal)
      return Response.json({ message: "PRIVATE_SENTINEL" }, { status: 503, headers: { "x-request-id": requestId } })
    }
    const failure = yield* reviewRequest("readiness", "GET", "/health/ready", 200).pipe(
      Effect.flip,
      Effect.provideService(ReviewTransport, transport)
    )
    expect(failure.status).toBe(503)
    expect(JSON.stringify(failure)).not.toContain("PRIVATE_SENTINEL")
    const excess: typeof fetch = async () =>
      Response.json({ status: "ready", privateEmail: "PRIVATE_SENTINEL" }, { headers: { "x-request-id": requestId } })
    const leaked = yield* reviewJson(
      "readiness",
      "GET",
      "/health/ready",
      200,
      Schema.Struct({ status: Schema.Literal("ready") })
    ).pipe(Effect.flip, Effect.provideService(ReviewTransport, excess))
    expect(leaked.message).toBe("Response does not match the API schema.")
    expect(JSON.stringify(leaked)).not.toContain("PRIVATE_SENTINEL")
  })
)

it.effect("rejects malformed response schemas and transport errors without preserving raw causes", () =>
  Effect.gen(function* () {
    const malformed: typeof fetch = async () =>
      Response.json({ status: "PRIVATE_SENTINEL" }, { headers: { "x-request-id": requestId } })
    const failure = yield* reviewJson(
      "readiness",
      "GET",
      "/health/ready",
      200,
      Schema.Struct({ status: Schema.Literal("ready") })
    ).pipe(Effect.flip, Effect.provideService(ReviewTransport, malformed))
    expect(failure.message).toBe("Response does not match the API schema.")
    expect(JSON.stringify(failure)).not.toContain("PRIVATE_SENTINEL")
    const broken: typeof fetch = async () => {
      throw new Error("PRIVATE_SENTINEL")
    }
    const network = yield* reviewRequest("readiness", "GET", "/health/ready", 200).pipe(
      Effect.flip,
      Effect.provideService(ReviewTransport, broken)
    )
    expect(JSON.stringify(network)).not.toContain("PRIVATE_SENTINEL")
  })
)
