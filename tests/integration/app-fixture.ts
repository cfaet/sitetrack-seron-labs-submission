import { Effect, Layer, Redacted, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { SqlClient } from "effect/sql"
import { applicationRoutes } from "../../src/api/application.js"
import { AuthSettings } from "../../src/config/auth.js"
import * as Model from "../../src/domain/models.js"
import { initializeDatabase } from "../../src/db/migrate.js"
import { withTestDatabase } from "./database-fixture.js"

export const testAuth = { secret: Redacted.make("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc"), secureCookie: false, origins: ["http://localhost:3000", "http://localhost:5173"] }
export const password = "Synthetic password for testing only!"
export interface Client { readonly token?: string; readonly cookie?: string }
export const withApp = <A>(run: (app: TestApp) => Promise<A>, options: { readonly secureCookie?: boolean } = {}) => withTestDatabase((config) => Effect.gen(function*() {
  yield* initializeDatabase(config)
  const context = yield* Effect.context<SqlClient.SqlClient>()
  const sql = yield* SqlClient.SqlClient
  const web = HttpRouter.toWebHandler(applicationRoutes.pipe(Layer.provide(Layer.succeed(AuthSettings, { ...testAuth, ...options })), Layer.provide(Layer.succeedContext(context)), Layer.provide(HttpServer.layerServices)), { disableLogger: true })
  yield* Effect.addFinalizer(() => Effect.promise(web.dispose))
  const request = (method: string, path: string, body?: unknown, client: Client = {}, extra: Readonly<Record<string,string>> = {}) => {
    const headers = new Headers({ "X-CSRF-Protection": "1", ...extra })
    if (client.token) headers.set("Authorization", `Bearer ${client.token}`)
    if (client.cookie) headers.set("Cookie", client.cookie)
    if (body !== undefined) headers.set("Content-Type", "application/json")
    return web.handler(new Request(`http://localhost:3000${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
  }
  const register = async (email: string, role: typeof Model.Role.Type = "User") => {
    const response = await request("POST", "/api/v1/auth/register", { name: "Test User", email, password, role })
    if (response.status !== 201) throw new Error(`Registration failed with ${response.status}: ${await response.text()}`)
    const body = Schema.decodeUnknownSync(Model.SessionResult)(await response.json())
    return { body, token: body.accessToken, cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "" }
  }
  return yield* Effect.promise(() => run({ request, register, sql }))
}))
export interface TestApp {
  readonly request: (method: string, path: string, body?: unknown, client?: Client, extra?: Readonly<Record<string,string>>) => Promise<Response>
  readonly register: (email: string, role?: typeof Model.Role.Type) => Promise<{ body: typeof Model.SessionResult.Type; token: string; cookie: string }>
  readonly sql: SqlClient.SqlClient
}
