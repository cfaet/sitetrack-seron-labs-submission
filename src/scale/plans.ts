import { DateTime, Effect, Schema } from "effect"
import { SqlClient, Statement, type SqlError } from "effect/sql"
import { companyInstant, readCompanyZone } from "../config/company.js"
import type { AppError } from "../domain/errors.js"
import { Actor } from "../domain/models.js"
import { Database } from "../repositories/database.js"
import { readProjects } from "../repositories/projects.js"
import { loadTaskGraph } from "../repositories/tasks.js"
import { companyStock, projectStock } from "../repositories/inventory.js"
import { readDeliveries } from "../repositories/deliveries.js"
import { referenceDate, uid, profiles, type Profile } from "./profile.js"

export const plans = Effect.fn("scale.plans")(function* (profile: Profile) {
  const sql = yield* SqlClient.SqlClient
  const zone = yield* readCompanyZone(process.env)
  const company = companyInstant(yield* DateTime.now, zone)
  const actor = yield* Schema.decodeEffect(Actor)({
    user: {
      id: uid(1, 1),
      name: "Demo",
      email: "user1@sitetrack.example",
      role: "SuperAdmin",
      createdAt: `${referenceDate}T00:00:00.000Z`
    },
    sessionId: uid(1, 1)
  })
  const member = { ...actor, user: { ...actor.user, id: uid(1, 3), role: "User" as const } }
  const queries: ReadonlyArray<readonly [string, Effect.Effect<unknown, AppError | SqlError.SqlError, Database>]> = [
    ["projects", readProjects(actor, {}, company.today)],
    ["projects-member", readProjects(member, {}, company.today)],
    ["projects-completion", readProjects(actor, { sort: "completionPercentage", direction: "desc" }, company.today)],
    ["projects-late", readProjects(actor, { hasLate: "true", sort: "lateCount", direction: "desc" }, company.today)],
    [
      "projects-search-deep",
      readProjects(actor, { search: "Project", page: Math.ceil(profiles[profile].projects / 25) }, company.today)
    ],
    ["project-detail", readProjects(actor, {}, company.today, "PRJ-0001")],
    ["task-graph", loadTaskGraph(actor, "PRJ-0001")],
    ["company-stock", companyStock(actor, {})],
    ["company-stock-quantity", companyStock(actor, { sort: "quantity" })],
    ["project-stock", projectStock(actor, "PRJ-0001", {})],
    ["company-deliveries", readDeliveries(actor, {})],
    [
      "filtered-deliveries",
      readDeliveries(actor, {
        status: "Delivered",
        direction: "CompanyToProject",
        fromDate: "2025-01-01",
        toDate: "2027-01-01"
      })
    ],
    ["company-deliveries-deep", readDeliveries(actor, { page: Math.ceil(profiles[profile].deliveries / 25) })]
  ]
  const output: Array<{ name: string; sql: string; parameters: ReadonlyArray<unknown>; plan: ReadonlyArray<unknown> }> =
    []
  for (const [name, query] of queries) {
    const captured: Array<readonly [string, ReadonlyArray<unknown>]> = []
    yield* query.pipe(
      Effect.provideService(Database, sql),
      Effect.provideService(Statement.CurrentTransformer, (statement) =>
        Effect.sync(() => {
          captured.push(statement.compile())
          return statement
        })
      )
    )
    for (const [text, params] of captured) {
      if (!/^\s*(?:SELECT|WITH)\b/i.test(text)) throw new Error("Plan capture only accepts read queries.")
      const plan = yield* sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${text}`, params)
      output.push({ name, sql: text, parameters: params, plan })
    }
  }
  return { company, queries: output }
})
