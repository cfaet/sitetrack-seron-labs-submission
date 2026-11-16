import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Option, Schema } from "effect"
import { CaptureError, type CaptureFailure } from "./capture.js"

const RequestId = Schema.String.check(Schema.isUUID())
const Timestamp = Schema.String.check(Schema.isPattern(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/))
const Category = Schema.Literals(["connection_acquisition", "statement_timeout", "lock_timeout", "other_sql_failure"])
const Reason = Schema.Literals([
  "ConnectionError",
  "AuthenticationError",
  "AuthorizationError",
  "SqlSyntaxError",
  "UniqueViolation",
  "ConstraintError",
  "DeadlockError",
  "SerializationError",
  "LockTimeoutError",
  "StatementTimeoutError",
  "UnknownError"
])
const ApiEntry = Schema.fromJsonString(
  Schema.Struct({
    timestamp: Timestamp,
    annotations: Schema.optional(Schema.Struct({ requestId: Schema.optional(RequestId) })),
    message: Schema.Union([
      Schema.Struct({
        event: Schema.Literal("request"),
        method: Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
        status: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
        requestId: RequestId,
        durationMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
      }),
      Schema.Struct({ event: Schema.Literal("database_failure"), category: Category, reason: Reason }),
      Schema.Struct({ event: Schema.Literal("request_failed"), requestId: RequestId })
    ])
  })
)

// Project an allowlist: never persist raw log lines, causes, SQL, headers or bodies.
export const sanitizeApiLogs = (text: string) => {
  const output = []
  for (const line of text.split("\n")) {
    const json = line.replace(/^\S+\s+(?=\{)/, "")
    const decoded = Schema.decodeOption(ApiEntry)(json)
    if (Option.isNone(decoded)) continue
    const entry = decoded.value,
      message = entry.message
    if (message.event === "request")
      output.push({
        timestamp: entry.timestamp,
        event: message.event,
        method: message.method,
        status: message.status,
        requestId: message.requestId,
        durationMs: message.durationMs
      })
    else if (message.event === "database_failure")
      output.push({
        timestamp: entry.timestamp,
        event: message.event,
        category: message.category,
        reason: message.reason,
        requestId: entry.annotations?.requestId ?? null
      })
    else output.push({ timestamp: entry.timestamp, event: message.event, requestId: message.requestId })
  }
  return output
}

export const sanitizePostgresLogs = (text: string) => {
  const output: Array<{ timestamp: string; event: string }> = []
  for (const line of text.split("\n")) {
    // Only anchored PostgreSQL server messages; STATEMENT/DETAIL and continuation lines are discarded.
    const match =
      /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z) \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+ UTC \[\d+\] (?:ERROR|FATAL):  (.+)$/.exec(
        line
      )
    if (!match?.[1]) continue
    const event =
      match[2] === "canceling statement due to statement timeout"
        ? "statement_timeout"
        : match[2] === "canceling statement due to lock timeout"
          ? "lock_timeout"
          : match[2] === "deadlock detected"
            ? "deadlock"
            : match[2] === "sorry, too many clients already"
              ? "too_many_connections"
              : match[2] === "out of memory"
                ? "out_of_memory"
                : null
    if (event !== null) output.push({ timestamp: match[1], event })
  }
  return output
}

export const pressureSnapshot = async () => {
  const output: Record<string, { available: boolean; some: number | null; full: number | null }> = {}
  for (const resource of ["cpu", "io", "memory"]) {
    try {
      const text = await readFile(`/proc/pressure/${resource}`, "utf8")
      const total = (kind: string) => {
        const match = new RegExp(`^${kind} .*total=(\\d+)$`, "m").exec(text)
        return match?.[1] === undefined ? null : Number(match[1])
      }
      output[resource] = { available: true, some: total("some"), full: total("full") }
    } catch {
      output[resource] = { available: false, some: null, full: null }
    }
  }
  return output
}

export const collectScaleDiagnostics = async (
  directory: string,
  prefix: string,
  since: string,
  until: string,
  logs: (service: "api" | "db", since: string, until: string) => Promise<string>
) => {
  interface Source {
    service: "api" | "db"
    status: "saved" | "partial" | "unavailable"
    filename: string | null
    events: number
    reason: CaptureFailure | "write_failed" | null
    exitCode: number | null
  }
  const capture = async (service: "api" | "db"): Promise<Source> => {
    const filename = `${prefix}-${service === "api" ? "api" : "postgres"}.jsonl`
    let raw = "",
      reason: CaptureFailure | null = null,
      exitCode: number | null = null
    try {
      raw = await logs(service, since, until)
    } catch (error) {
      reason = error instanceof CaptureError ? error.reason : "unknown"
      if (error instanceof CaptureError) {
        raw = error.output
        exitCode = error.exitCode
      }
    }
    if (reason !== null && raw.length === 0)
      return { service, status: "unavailable", filename: null, events: 0, reason, exitCode }
    const events = service === "api" ? sanitizeApiLogs(raw) : sanitizePostgresLogs(raw)
    try {
      await writeFile(join(directory, filename), events.map((event) => JSON.stringify(event) + "\n").join(""))
      return {
        service,
        status: reason === null ? "saved" : "partial",
        filename,
        events: events.length,
        reason,
        exitCode
      }
    } catch {
      return { service, status: "unavailable", filename: null, events: 0, reason: "write_failed", exitCode }
    }
  }
  // Serial collection avoids two cold CLI startups competing for the same HDD.
  const sources = [await capture("api"), await capture("db")]
  const diagnostics = {
    since,
    until,
    tailLimitPerService: 50000,
    byteLimitPerService: 16 * 1024 * 1024,
    sources,
    policy:
      "Allowlisted events only. Empty files do not prove absence of failures; capture is bounded and filters unknown formats."
  }
  await writeFile(join(directory, `${prefix}-diagnostics.json`), JSON.stringify(diagnostics, null, 2) + "\n")
  return diagnostics
}
