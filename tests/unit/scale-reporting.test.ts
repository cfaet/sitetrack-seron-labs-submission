import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  BenchmarkFailed,
  benchmarkFailureMessage,
  measureCase,
  summarizeBenchmark
} from "../../src/scale/measurement.js"
import { collectScaleDiagnostics, sanitizeApiLogs, sanitizePostgresLogs } from "../../src/scale/diagnostics.js"
import { captureCommand, CaptureError } from "../../src/scale/capture.js"

const requestId = "b102e7b1-38f0-4d68-ae9e-90d538b053f7"
const timestamp = "2026-11-16T06:55:00.000Z"
const success = { milliseconds: 10, error: null, requestId }

describe("benchmark phase reporting", () => {
  it("shows mixed-workload failures even when timed case requests all succeed", async () => {
    const result = await measureCase(
      { name: "control", target: 500 },
      1,
      { clients: 1, warmup: 1, samples: 2 },
      async () => success,
      () => {}
    )
    const summary = summarizeBenchmark({
      result: {
        verdict: "request_errors",
        expectedCases: 1,
        protocol: { samples: 2 },
        results: [result],
        mixed: [{ requests: 20, errors: 3 }]
      }
    })
    expect(summary).toContain("Measured: 2/2 successful; 0/2 errors")
    expect(summary).toContain("Mixed workload: 3/20 errors")
    expect(summary).toContain("Verdict: request_errors")
  })
  it("keeps a warmup-only 503 visible when all measured requests succeed", async () => {
    let calls = 0
    const result = await measureCase(
      { name: "deliveries", target: 500 },
      1,
      { clients: 2, warmup: 2, samples: 5 },
      async () => (++calls === 2 ? { milliseconds: 2000, error: "HTTP_503", requestId } : success),
      () => {}
    )
    expect(result.complete).toBe(true)
    expect(result.samples).toBe(5)
    expect(result.attempts).toBe(8)
    expect(result.targetMet).toBe(false)
    expect(result.p95).toBe(10)
    expect(result.phaseResults.warmup).toEqual({ attempts: 2, successes: 1, errors: { HTTP_503: 1 }, errorRate: 0.5 })
    expect(result.phaseResults.measured).toEqual({ attempts: 5, successes: 5, errors: {}, errorRate: 0 })
    expect(result.failures).toMatchObject([{ phase: "warmup", error: "HTTP_503", requestId }])
    const failure = new BenchmarkFailed({ message: benchmarkFailureMessage("request_errors") })
    expect(failure._tag).toBe("BenchmarkFailed")
    expect(failure.message).toContain("warmup")
  })
  it("counts measured failures separately and excludes them from latency percentiles", async () => {
    let calls = 0
    const result = await measureCase(
      { name: "projects", target: 500 },
      1,
      { clients: 2, warmup: 1, samples: 4 },
      async () => {
        if (++calls === 3) throw new Error("PRIVATE_SENTINEL")
        return success
      },
      () => {}
    )
    expect(result.phaseResults.measured).toEqual({
      attempts: 4,
      successes: 3,
      errors: { TIMEOUT_OR_NETWORK: 1 },
      errorRate: 0.25
    })
    expect(result.samples).toBe(3)
    expect(result.complete).toBe(true)
    expect(result.p95).toBe(10)
    expect(result.failures).toMatchObject([{ phase: "measured", requestId: null }])
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL")
  })
  it("preserves the first-access failure and marks measured work incomplete", async () => {
    const result = await measureCase(
      { name: "projects", target: 500 },
      1,
      { clients: 2, warmup: 1, samples: 4 },
      async () => ({ milliseconds: 20, error: "HTTP_503", requestId: "PRIVATE_SENTINEL" }),
      () => {}
    )
    expect(result.phaseResults.firstAccess.errors).toEqual({ HTTP_503: 1 })
    expect(result.phaseResults.measured.attempts).toBe(0)
    expect(result.complete).toBe(false)
    expect(result.failures[0]?.requestId).toBeNull()
    expect(result.p95).toBeNull()
    expect(benchmarkFailureMessage("incomplete")).toContain("did not finish")
  })
})

const apiLogs = [
  JSON.stringify({
    timestamp,
    message: {
      event: "database_failure",
      category: "connection_acquisition",
      reason: "ConnectionError",
      sql: "PRIVATE_SENTINEL"
    },
    annotations: { requestId, token: "PRIVATE_SENTINEL" },
    cause: "PRIVATE_SENTINEL"
  }),
  JSON.stringify({
    timestamp,
    message: {
      event: "request",
      method: "GET",
      status: 503,
      requestId,
      durationMs: 2001,
      headers: "PRIVATE_SENTINEL",
      body: "PRIVATE_SENTINEL"
    }
  }),
  JSON.stringify({ timestamp, message: "PRIVATE_SENTINEL" }),
  JSON.stringify({
    timestamp,
    message: { event: "database_failure", category: "PRIVATE_SENTINEL", reason: "UnknownError" }
  }),
  "PRIVATE_SENTINEL"
]
  .map((line) => `${timestamp} ${line}`)
  .join("\n")
const pgLogs = `${timestamp} 2026-11-16 06:55:00.000 UTC [123] ERROR:  canceling statement due to statement timeout
${timestamp} 2026-11-16 06:55:00.000 UTC [123] STATEMENT: SELECT 'PRIVATE_SENTINEL'
${timestamp} 2026-11-16 06:55:00.000 UTC [123] DETAIL: PRIVATE_SENTINEL
${timestamp} 2026-11-16 06:55:00.000 UTC [124] ERROR:  canceling statement due to lock timeout
${timestamp} 2026-11-16 06:55:00.000 UTC [124] ERROR:  PRIVATE_SENTINEL
PRIVATE_SENTINEL`

describe("saved scale diagnostics", () => {
  it("retains request correlation and fixed PostgreSQL events without private payloads", () => {
    expect(sanitizeApiLogs(apiLogs)).toEqual([
      {
        timestamp,
        event: "database_failure",
        category: "connection_acquisition",
        reason: "ConnectionError",
        requestId
      },
      { timestamp, event: "request", method: "GET", status: 503, requestId, durationMs: 2001 }
    ])
    expect(sanitizePostgresLogs(pgLogs)).toEqual([
      { timestamp, event: "statement_timeout" },
      { timestamp, event: "lock_timeout" }
    ])
    expect(JSON.stringify([sanitizeApiLogs(apiLogs), sanitizePostgresLogs(pgLogs)])).not.toContain("PRIVATE_SENTINEL")
  })
  it("saves diagnostics after a failed run and records unavailable sources explicitly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sitetrack-scale-reporting-"))
    try {
      const saved = await collectScaleDiagnostics(directory, "focus-failed", timestamp, timestamp, async (service) => {
        if (service === "db") throw new Error("PRIVATE_SENTINEL")
        return apiLogs
      })
      expect(saved.sources).toEqual([
        {
          service: "api",
          status: "saved",
          filename: "focus-failed-api.jsonl",
          events: 2,
          reason: null,
          exitCode: null
        },
        { service: "db", status: "unavailable", filename: null, events: 0, reason: "unknown", exitCode: null }
      ])
      const contents = await Promise.all(
        (await readdir(directory)).map((file) => readFile(join(directory, file), "utf8"))
      )
      expect(contents.join("\n")).not.toContain("PRIVATE_SENTINEL")
      expect(contents.join("\n")).toContain(requestId)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it("preserves sanitized partial events and the safe capture failure reason", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sitetrack-scale-partial-"))
    try {
      const saved = await collectScaleDiagnostics(directory, "focus-partial", timestamp, timestamp, async (service) => {
        if (service === "api") throw new CaptureError("timeout", null, apiLogs)
        throw new CaptureError("command_failed", 7, pgLogs)
      })
      expect(saved.sources).toMatchObject([
        { service: "api", status: "partial", events: 2, reason: "timeout", exitCode: null },
        { service: "db", status: "partial", events: 2, reason: "command_failed", exitCode: 7 }
      ])
      const files = await Promise.all((await readdir(directory)).map((name) => readFile(join(directory, name), "utf8")))
      expect(files.join("\n")).not.toContain("PRIVATE_SENTINEL")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it("identifies write failures without replacing them with empty successful captures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sitetrack-scale-write-"))
    try {
      await mkdir(join(directory, "focus-blocked-api.jsonl"))
      const saved = await collectScaleDiagnostics(directory, "focus-blocked", timestamp, timestamp, async () => apiLogs)
      expect(saved.sources[0]).toMatchObject({ status: "unavailable", reason: "write_failed", filename: null })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it("retains both output streams on command failure without leaking them to the console", async () => {
    const error = await captureCommand(
      process.execPath,
      ["-e", "process.stdout.write('first'); process.stderr.write('PRIVATE_SENTINEL'); process.exitCode=7"],
      { env: process.env }
    ).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(CaptureError)
    if (!(error instanceof CaptureError)) throw new Error("Expected capture failure")
    expect(error.reason).toBe("command_failed")
    expect(error.exitCode).toBe(7)
    expect(error.output).toContain("first")
    expect(error.output).toContain("PRIVATE_SENTINEL")
    expect(error.message).not.toContain("PRIVATE_SENTINEL")
  })
  it("bounds capture time and reports a timeout", async () => {
    await expect(
      captureCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], { env: process.env, timeoutMs: 200 })
    ).rejects.toMatchObject({ reason: "timeout" })
  })
  it("bounds captured bytes and retains partial output", async () => {
    const error = await captureCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(100))"], {
      env: process.env,
      maxBytes: 8
    }).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(CaptureError)
    if (!(error instanceof CaptureError)) throw new Error("Expected capture failure")
    expect(error.reason).toBe("output_limit")
    expect(error.output).toBe("xxxxxxxx")
  })
  it("classifies a missing diagnostic executable without exposing OS error text", async () => {
    await expect(
      captureCommand("/sitetrack-no-such-diagnostic-executable", [], { env: process.env })
    ).rejects.toMatchObject({ reason: "spawn_failed", output: "" })
  })
})
