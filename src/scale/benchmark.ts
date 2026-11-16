import { DateTime, Effect, Schema } from "effect"
import { companyInstant, readCompanyZone } from "../config/company.js"
import { SqlClient } from "effect/sql"
import * as M from "../domain/models.js"
import * as T from "../domain/task-models.js"
import * as I from "../domain/inventory-models.js"
import { rows } from "../repositories/database.js"
import { demoPassword, percentile, profiles, projectPlan, type Profile } from "./profile.js"
import { measureCase, safeRequestId, type RequestFailure } from "./measurement.js"

interface Case {
  readonly name: string
  readonly path: string
  readonly account: number
  readonly schema: Schema.ConstraintDecoder<unknown>
  readonly target: number
}
interface Account {
  readonly id: number
  token: string
  cookie: string
  expiry: number
}
export type BenchmarkMode = "smoke" | "focus" | "bench"
export const benchmarkProtocol = (mode: BenchmarkMode) => ({
  clients: mode === "smoke" ? 2 : 10,
  samples: mode === "smoke" ? 20 : mode === "focus" ? 50 : 200,
  repetitions: mode === "bench" ? 3 : 1,
  warmup: mode === "smoke" ? 2 : 20
})
const focusedCases = new Set([
  "profile",
  "projects-member",
  "projects-company",
  "projects-completion",
  "projects-late",
  "projects-search-deep",
  "project-detail",
  "tasks",
  "prerequisites",
  "materials",
  "company-deliveries",
  "company-deliveries-filter",
  "company-deliveries-deep"
])
export const benchmarkCases = (profile: Profile, mode: BenchmarkMode = "bench"): ReadonlyArray<Case> => {
  const c = profiles[profile],
    n = projectPlan(profile)[0]?.tasks ?? 0,
    last = `PRJ-0001-T-${String(n).padStart(4, "0")}`
  const page = (schema: Schema.ConstraintDecoder<unknown>) => M.collection(schema)
  const common = (
    name: string,
    path: string,
    schema: Schema.ConstraintDecoder<unknown>,
    account = 3,
    target = 500
  ): Case => ({
    name,
    path,
    schema,
    account,
    target
  })
  const cases = [
    common("profile", "/me", M.User),
    common("projects-member", "/projects", page(M.Project)),
    common("projects-company", "/projects", page(M.Project), 1),
    common("projects-completion", "/projects?sort=completionPercentage&direction=desc", page(M.Project), 1),
    common("projects-late", "/projects?hasLate=true&sort=lateCount&direction=desc", page(M.Project), 1),
    common("projects-search-deep", `/projects?search=Project&page=${Math.ceil(c.projects / 25)}`, page(M.Project), 1),
    common("project-detail", "/projects/PRJ-0001", M.Project, 3, 1000),
    common("tasks", "/projects/PRJ-0001/tasks", page(T.Task)),
    common("tasks-late-blocked", "/projects/PRJ-0001/tasks?late=true&blocked=true", page(T.Task)),
    common("tasks-sort", "/projects/PRJ-0001/tasks?sort=dependentCount&direction=desc", page(T.Task)),
    common("tasks-search-deep", `/projects/PRJ-0001/tasks?search=Task&page=${Math.ceil(n / 25)}`, page(T.Task)),
    common("task-detail", `/projects/PRJ-0001/tasks/${last}`, T.TaskDetail, 3, 1000),
    common("prerequisites", `/projects/PRJ-0001/tasks/${last}/prerequisites`, page(T.TaskRelation), 3, 1000),
    common("dependents", "/projects/PRJ-0001/tasks/PRJ-0001-T-0001/dependents", page(T.TaskRelation), 3, 1000),
    common("project-stock", "/projects/PRJ-0001/store?sort=lastDelivery&direction=desc", page(I.ProjectStock)),
    common("materials", "/materials?search=Material&category=Category%201", page(I.Material)),
    common("company-stock", "/company-store/stock", page(I.CompanyStock), 2),
    common("company-stock-quantity", "/company-store/stock?sort=quantity&direction=desc", page(I.CompanyStock), 2),
    common("company-stock-status", "/company-store/stock?sort=status&status=LowStock", page(I.CompanyStock), 2),
    common(
      "company-stock-category",
      "/company-store/stock?search=Material&category=Category%201",
      page(I.CompanyStock),
      2
    ),
    common("company-deliveries", "/company-store/deliveries", page(I.Delivery), 2),
    common(
      "company-deliveries-filter",
      "/company-store/deliveries?status=Delivered&direction=CompanyToProject&fromDate=2025-01-01&toDate=2027-01-01",
      page(I.Delivery),
      2
    ),
    common(
      "company-deliveries-deep",
      `/company-store/deliveries?page=${Math.ceil(c.deliveries / 25)}`,
      page(I.Delivery),
      2
    ),
    common("project-deliveries", "/projects/PRJ-0001/deliveries?direction=ProjectToCompany", page(I.Delivery)),
    common("members", "/projects/PRJ-0001/members", page(M.Member)),
    common("invitations", "/projects/PRJ-0001/invitations", page(M.Invitation)),
    common("notifications", "/notifications", page(M.Notification), 4),
    common("unread", "/notifications/unread-count", Schema.Struct({ count: Schema.Int }), 4)
  ]
  return mode === "focus" ? cases.filter((test) => focusedCases.has(test.name)) : cases
}
export const benchmark = Effect.fn("benchmark")(function* (profile: Profile, mode: BenchmarkMode) {
  const sql = yield* SqlClient.SqlClient
  const zone = yield* readCompanyZone(process.env)
  const company = companyInstant(yield* DateTime.now, zone)
  const run = Effect.runPromiseWith(yield* Effect.context<never>())
  const storage = yield* rows(
    Schema.Struct({ bytes: Schema.String, timezone: Schema.String }),
    sql`SELECT pg_database_size(current_database())::text AS bytes,current_setting('TimeZone') AS timezone`
  )
  const base = process.env.BENCH_BASE_URL ?? "http://127.0.0.1:3000"
  const cases = benchmarkCases(profile, mode),
    { clients, samples, repetitions, warmup } = benchmarkProtocol(mode)
  return yield* Effect.promise(async () => {
    const accounts = new Map<number, Account>()
    const results: Array<Awaited<ReturnType<typeof measureCase>>> = []
    const mixed: Array<{
      repetition: number
      requests: number
      errors: number
      p95: number | null
      seconds: number
      failures: ReadonlyArray<RequestFailure>
      omittedFailures: number
    }> = []
    const onError = (failure: RequestFailure) =>
      process.stderr.write(JSON.stringify({ event: "benchmark_request_error", ...failure }) + "\n")
    let failure: string | null = null
    const created: Array<Account> = []
    let phase = "login"
    const authentication: Array<{ account: number; milliseconds: number }> = []
    const login = async (id: number) => {
      const started = performance.now()
      const response = await fetch(`${base}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Protection": "1" },
        body: JSON.stringify({ email: `user${id}@sitetrack.example`, password: demoPassword }),
        signal: AbortSignal.timeout(10000)
      })
      if (response.status !== 200) throw new Error(`Benchmark login returned ${response.status}.`)
      const body = await run(rows(M.SessionResult, Effect.succeed([await response.json()])))
      const value = body[0]
      if (!value) throw new Error("Missing benchmark session.")
      const account: Account = {
        id,
        token: value.accessToken,
        cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
        expiry: Date.parse(value.accessTokenExpiresAt)
      }
      accounts.set(id, account)
      created.push(account)
      authentication.push({ account: id, milliseconds: performance.now() - started })
    }
    const refresh = async (account: Account) => {
      const response = await fetch(`${base}/api/v1/auth/refresh`, {
        method: "POST",
        headers: { Cookie: account.cookie, "Content-Type": "application/json", "X-CSRF-Protection": "1" },
        body: "{}",
        signal: AbortSignal.timeout(10000)
      })
      if (response.status !== 200) throw new Error("Benchmark session refresh failed.")
      const body = await run(rows(M.SessionResult, Effect.succeed([await response.json()])))
      const value = body[0]
      if (!value) throw new Error("Missing refreshed benchmark session.")
      account.token = value.accessToken
      account.expiry = Date.parse(value.accessTokenExpiresAt)
      account.cookie = response.headers.get("set-cookie")?.split(";")[0] ?? ""
    }
    try {
      for (const id of [1, 2, 3, 4, profiles[profile].users]) await login(id)
      const request = async (test: Case) => {
        const account = accounts.get(test.account)
        if (!account) throw new Error("Unknown benchmark account.")
        const started = performance.now()
        const response = await fetch(`${base}/api/v1${test.path}`, {
          headers: { Authorization: `Bearer ${account.token}` },
          signal: AbortSignal.timeout(10000)
        })
        const requestId = safeRequestId(response.headers.get("x-request-id"))
        if (response.status !== 200) {
          await response.arrayBuffer()
          return { milliseconds: performance.now() - started, error: `HTTP_${response.status}`, requestId }
        }
        try {
          await run(rows(test.schema, Effect.succeed([await response.json()])))
        } catch {
          return { milliseconds: performance.now() - started, error: "INVALID_RESPONSE", requestId }
        }
        return { milliseconds: performance.now() - started, error: null, requestId }
      }
      const accessCheck = async () => {
        for (const [id, path, status] of [
          [profiles[profile].users, "/projects/PRJ-0001", 404],
          [profiles[profile].users, "/projects/PRJ-9999", 404],
          [2, "/projects/PRJ-0001/tasks", 404],
          [3, "/company-store/stock", 403]
        ] as const) {
          const account = accounts.get(id)
          if (!account) throw new Error("Missing access-check account.")
          const response = await fetch(`${base}/api/v1${path}`, {
            headers: { Authorization: `Bearer ${account.token}` },
            signal: AbortSignal.timeout(10000)
          })
          await response.arrayBuffer()
          if (response.status !== status)
            throw new Error(`Benchmark ACL probe expected ${status}, received ${response.status}.`)
        }
      }
      phase = "access-before"
      await accessCheck()
      for (let repetition = 1; repetition <= repetitions; repetition++) {
        for (const account of accounts.values()) if (account.expiry - Date.now() < 180000) await refresh(account)
        for (const test of cases) {
          const active = accounts.get(test.account)
          if (active && active.expiry - Date.now() < 180000) await refresh(active)
          process.stderr.write(JSON.stringify({ event: "benchmark_case", name: test.name, repetition }) + "\n")
          phase = `case:${test.name}:${repetition}`
          results.push(await measureCase(test, repetition, { clients, samples, warmup }, () => request(test), onError))
          process.stderr.write(JSON.stringify({ event: "benchmark_case_result", result: results.at(-1) }) + "\n")
        }
        if (mode === "bench") {
          phase = `mixed:${repetition}`
          const started = performance.now(),
            until = started + 60000,
            timings: Array<number> = []
          let next = 0,
            errors = 0
          const failures: Array<RequestFailure> = []
          const recordFailure = (error: string, requestId: string | null, name: string) => {
            errors++
            if (failures.length >= 100) return
            const failure = {
              name,
              repetition,
              phase: "mixed" as const,
              timestamp: new Date().toISOString(),
              error,
              requestId
            }
            failures.push(failure)
            onError(failure)
          }
          await Promise.all(
            Array.from({ length: clients }, async () => {
              while (performance.now() < until) {
                const test = cases[next++ % cases.length]
                if (!test) throw new Error("Missing workload case.")
                try {
                  const result = await request(test)
                  if (result.error) recordFailure(result.error, result.requestId, test.name)
                  else timings.push(result.milliseconds)
                } catch {
                  recordFailure("TIMEOUT_OR_NETWORK", null, test.name)
                }
              }
            })
          )
          mixed.push({
            repetition,
            requests: next,
            errors,
            failures,
            omittedFailures: errors - failures.length,
            p95: percentile(timings, 0.95),
            seconds: (performance.now() - started) / 1000
          })
        }
      }
      for (const account of accounts.values()) if (account.expiry - Date.now() < 60000) await refresh(account)
      phase = "access-after"
      await accessCheck()
    } catch {
      failure = `Benchmark failed during ${phase}; completed case results are retained.`
    } finally {
      // End only sessions created by this runner; cookies/tokens are never serialized.
      for (const account of created)
        await fetch(`${base}/api/v1/auth/logout`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${account.token}`,
            Cookie: account.cookie,
            "Content-Type": "application/json",
            "X-CSRF-Protection": "1"
          },
          body: "{}",
          signal: AbortSignal.timeout(10000)
        })
          .then(async (r) => {
            await r.arrayBuffer()
            if (r.status !== 204) failure = "Benchmark session cleanup failed."
          })
          .catch(() => {
            failure = "Benchmark session cleanup failed."
          })
    }
    const hasErrors = results.some((r) => Object.keys(r.errors).length > 0) || mixed.some((r) => r.errors > 0)
    const complete = results.length === cases.length * repetitions && results.every((r) => r.complete)
    const verdict =
      failure !== null ? "execution_failed" : !complete ? "incomplete" : hasErrors ? "request_errors" : "passed"
    return {
      profile,
      smoke: mode === "smoke",
      mode,
      company,
      protocol: {
        clients,
        samples,
        repetitions,
        warmup,
        requestTimeoutMs: 10000,
        caseDeadlineMs: 120000,
        model:
          "closed-loop; schema validation included; per-case first access is not OS-cold; later repetitions are already warm"
      },
      storage: storage[0],
      authentication,
      failure,
      verdict,
      expectedCases: cases.length * repetitions,
      passed: verdict === "passed",
      targetsMet: results.length === cases.length * repetitions && results.every((r) => r.targetMet),
      results,
      mixed
    }
  })
})
