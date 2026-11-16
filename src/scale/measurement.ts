import { Data, Option, Schema } from "effect"
import { percentile } from "./profile.js"

export class BenchmarkFailed extends Data.TaggedError("BenchmarkFailed")<{
  readonly message: string
}> {}

export const benchmarkFailureMessage = (verdict: string) =>
  verdict === "request_errors"
    ? "Benchmark recorded request errors (including first access/warmup); report was emitted."
    : verdict === "incomplete"
      ? "Benchmark did not finish all measured requests; partial report was emitted."
      : "Benchmark execution or session cleanup failed; partial report was emitted."

const PhaseSummary = Schema.Struct({ attempts: Schema.Int, successes: Schema.Int })
const ReportSummary = Schema.Struct({
  result: Schema.Struct({
    verdict: Schema.Literals(["passed", "request_errors", "incomplete", "execution_failed"]),
    expectedCases: Schema.Int,
    protocol: Schema.Struct({ samples: Schema.Int }),
    mixed: Schema.Array(Schema.Struct({ requests: Schema.Int, errors: Schema.Int })),
    results: Schema.Array(
      Schema.Struct({
        complete: Schema.Boolean,
        targetMet: Schema.Boolean,
        phaseResults: Schema.Struct({ firstAccess: PhaseSummary, warmup: PhaseSummary, measured: PhaseSummary })
      })
    )
  })
})

export const summarizeBenchmark = (input: unknown) => {
  const decoded = Schema.decodeUnknownOption(ReportSummary)(input)
  if (Option.isNone(decoded)) return ""
  const { result } = decoded.value
  const counts = (phase: Phase) => {
    const attempts = result.results.reduce((sum, test) => sum + test.phaseResults[phase].attempts, 0)
    const successes = result.results.reduce((sum, test) => sum + test.phaseResults[phase].successes, 0)
    return { attempts, successes, errors: attempts - successes }
  }
  const measured = counts("measured"),
    warmup = counts("warmup"),
    first = counts("firstAccess")
  const mixed =
    result.mixed.length === 0
      ? ""
      : `Mixed workload: ${result.mixed.reduce((sum, run) => sum + run.errors, 0)}/${result.mixed.reduce((sum, run) => sum + run.requests, 0)} errors.\n`
  return (
    `Verdict: ${result.verdict}. Completed cases: ${result.results.filter((test) => test.complete).length}/${result.expectedCases}.\n` +
    `Measured: ${measured.successes}/${result.expectedCases * result.protocol.samples} successful; ${measured.errors}/${measured.attempts} errors.\n` +
    `Warmup: ${warmup.errors}/${warmup.attempts} errors. First access: ${first.errors}/${first.attempts} errors.\n` +
    mixed +
    `Latency targets met: ${result.results.filter((test) => test.targetMet).length}/${result.expectedCases}.\n`
  )
}

export const safeRequestId = (value: string | null) =>
  value !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null

export interface RequestResult {
  readonly milliseconds: number
  readonly error: string | null
  readonly requestId: string | null
}
type Phase = "firstAccess" | "warmup" | "measured"
const phaseResult = (): { attempts: number; successes: number; errors: Record<string, number>; errorRate: number } => ({
  attempts: 0,
  successes: 0,
  errors: {},
  errorRate: 0
})

// Shared by the real HTTP runner and focused phase/error regression tests.
export const measureCase = async (
  test: { readonly name: string; readonly target: number },
  repetition: number,
  protocol: { readonly samples: number; readonly warmup: number; readonly clients: number },
  request: () => Promise<RequestResult>,
  onError: (failure: RequestFailure) => void
) => {
  const phaseResults = { firstAccess: phaseResult(), warmup: phaseResult(), measured: phaseResult() }
  const errors: Record<string, number> = {},
    failures: Array<RequestFailure> = [],
    timings: Array<number> = []
  const deadline = performance.now() + 120000
  const measure = async (phase: Phase) => {
    const stats = phaseResults[phase]
    stats.attempts++
    let result: RequestResult
    try {
      result = await request()
    } catch {
      result = { milliseconds: 0, error: "TIMEOUT_OR_NETWORK", requestId: null }
    }
    if (result.error !== null) {
      stats.errors[result.error] = (stats.errors[result.error] ?? 0) + 1
      errors[result.error] = (errors[result.error] ?? 0) + 1
      const failure = {
        name: test.name,
        repetition,
        phase,
        timestamp: new Date().toISOString(),
        error: result.error,
        requestId: safeRequestId(result.requestId)
      }
      failures.push(failure)
      onError(failure)
    } else {
      stats.successes++
      if (phase === "measured") timings.push(result.milliseconds)
    }
    return result
  }
  const first = await measure("firstAccess")
  let measuredStarted = performance.now()
  if (first.error === null) {
    for (let i = 0; i < protocol.warmup; i++) {
      await measure("warmup")
      if (performance.now() > deadline) break
    }
    measuredStarted = performance.now()
    let next = 0
    await Promise.all(
      Array.from({ length: protocol.clients }, async () => {
        while (next < protocol.samples && performance.now() < deadline) {
          next++
          await measure("measured")
        }
      })
    )
  }
  for (const stats of Object.values(phaseResults))
    stats.errorRate = Object.values(stats.errors).reduce((sum, n) => sum + n, 0) / Math.max(1, stats.attempts)
  const attempts = Object.values(phaseResults).reduce((sum, stats) => sum + stats.attempts, 0),
    complete = phaseResults.measured.attempts === protocol.samples,
    p95 = percentile(timings, 0.95)
  return {
    name: test.name,
    repetition,
    firstAccessMs: first.error === "TIMEOUT_OR_NETWORK" ? null : first.milliseconds,
    samples: timings.length,
    attempts,
    errorRate: Object.values(errors).reduce((sum, n) => sum + n, 0) / Math.max(1, attempts),
    errors,
    phaseResults,
    failures,
    p50: percentile(timings, 0.5),
    p95,
    p99: percentile(timings, 0.99),
    requestsPerSecond: phaseResults.measured.attempts / ((performance.now() - measuredStarted) / 1000),
    targetMs: test.target,
    targetMet: complete && p95 !== null && p95 <= test.target && Object.keys(errors).length === 0,
    complete
  }
}

export interface RequestFailure {
  readonly name: string
  readonly repetition: number
  readonly phase: Phase | "mixed"
  readonly timestamp: string
  readonly error: string
  readonly requestId: string | null
}
