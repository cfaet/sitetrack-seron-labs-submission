import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { Database, execute, rows, UserRow } from "../repositories/database.js"
import { User, type Actor, Register, Login } from "../domain/models.js"
import { AppError, unauthorized } from "../domain/errors.js"
import { Passwords, Tokens } from "./security.js"
const Credentials = Schema.Struct({ ...UserRow.fields, passwordHash: Schema.String })
const Session = Schema.Struct({
  id: Schema.String,
  userId: Schema.String,
  refreshHash: Schema.String,
  idleExpires: Schema.Finite,
  absoluteExpires: Schema.Finite,
  revoked: Schema.Boolean
})
const digest = (token: string) => createHash("sha256").update(token).digest("hex")
const iso = (time: number) => new Date(time).toISOString()
const makeAuth = Effect.gen(function* () {
  const sql = yield* Database,
    passwords = yield* Passwords,
    tokens = yield* Tokens
  const user = Effect.fn("Auth.user")(function* (id: string) {
    const found = yield* rows(
      UserRow,
      sql`SELECT id::text,name,email,role,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt" FROM users WHERE id=${id}`
    )
    if (!found[0]) return yield* unauthorized()
    return yield* Schema.decodeEffect(User)(found[0]).pipe(Effect.orDie)
  })
  const session = Effect.fn("Auth.session")(function* (id: string, lock: "share" | "update") {
    const found = yield* rows(
      Session,
      sql`SELECT id::text,user_id::text AS "userId",refresh_hash AS "refreshHash",extract(epoch FROM idle_expires_at)::float8*1000 AS "idleExpires",extract(epoch FROM absolute_expires_at)::float8*1000 AS "absoluteExpires",revoked_at IS NOT NULL AS revoked FROM sessions WHERE id=${id} ${lock === "update" ? sql`FOR UPDATE` : sql`FOR SHARE`}`
    )
    const current = found[0],
      now = yield* Clock.currentTimeMillis
    if (!current || current.revoked || now >= current.idleExpires || now >= current.absoluteExpires)
      return yield* unauthorized()
    return current
  })
  const authorize = Effect.fn("Auth.authorize")(function* (token: string) {
    const claims = yield* tokens.verify(token)
    const current = yield* session(claims.sid, "share")
    if (current.userId !== claims.sub) return yield* unauthorized()
    return { user: yield* user(current.userId), sessionId: current.id } satisfies Actor
  }, execute)
  const lockActor = Effect.fn("Auth.lockActor")(function* (actor: Actor) {
    const current = yield* session(actor.sessionId, "share")
    if (current.userId !== actor.user.id) return yield* unauthorized()
    return { user: yield* user(current.userId), sessionId: current.id } satisfies Actor
  })
  const issue = Effect.fn("Auth.issue")(function* (
    account: User,
    id: string,
    refresh: string,
    now: number,
    idle: number,
    absolute: number
  ) {
    return {
      body: {
        user: account,
        accessToken: yield* tokens.sign(account.id, id, now, randomUUID()),
        tokenType: "Bearer" as const,
        accessTokenExpiresAt: iso(Math.floor(now / 1000) * 1000 + 900000),
        refreshExpiresAt: iso(idle),
        sessionExpiresAt: iso(absolute)
      },
      refresh,
      maxAge: Math.floor((idle - now) / 1000)
    }
  })
  const newSession = Effect.fn("Auth.newSession")(function* (account: User) {
    const now = yield* Clock.currentTimeMillis,
      id = randomUUID(),
      refresh = `${id}.${randomBytes(32).toString("base64url")}`
    const idle = now + 7 * 86400000,
      absolute = now + 30 * 86400000
    yield* sql`INSERT INTO sessions(id,user_id,refresh_hash,created_at,idle_expires_at,absolute_expires_at) VALUES (${id},${account.id},${digest(refresh)},${iso(now)},${iso(idle)},${iso(absolute)})`
    return yield* issue(account, id, refresh, now, idle, absolute)
  })
  const register = Effect.fn("Auth.register")(function* (input: typeof Register.Type) {
    const hash = yield* passwords.hash(input.password),
      id = randomUUID(),
      now = yield* Clock.currentTimeMillis
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES (${id},${input.name},${input.email.trim().toLowerCase()},${hash},${input.role},${iso(now)})`
        return yield* newSession(yield* user(id))
      })
    )
  }, execute)
  const login = Effect.fn("Auth.login")(function* (input: typeof Login.Type) {
    const accounts = yield* rows(
      Credentials,
      sql`SELECT id::text,name,email,role,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",password_hash AS "passwordHash" FROM users WHERE email=${input.email.trim().toLowerCase()}`
    )
    const account = accounts[0],
      valid = yield* passwords.verify(input.password, account?.passwordHash ?? passwords.dummy)
    if (!account || !valid)
      return yield* new AppError({ status: 401, code: "INVALID_CREDENTIALS", message: "Invalid email or password." })
    return yield* sql.withTransaction(newSession(yield* user(account.id)))
  }, execute)
  const refresh = Effect.fn("Auth.refresh")(function* (credential: string) {
    if (!/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(credential)) return yield* unauthorized()
    const id = yield* Schema.decodeEffect(Schema.String.check(Schema.isUUID()))(credential.slice(0, 36)).pipe(
      Effect.mapError(unauthorized)
    )
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* session(id, "update")
        const actual = Buffer.from(digest(credential), "hex"),
          expected = Buffer.from(current.refreshHash, "hex")
        if (expected.length !== 32 || !timingSafeEqual(actual, expected)) return yield* unauthorized()
        const now = yield* Clock.currentTimeMillis,
          idle = Math.min(now + 7 * 86400000, current.absoluteExpires)
        const next = `${id}.${randomBytes(32).toString("base64url")}`
        yield* sql`UPDATE sessions SET refresh_hash=${digest(next)},idle_expires_at=${iso(idle)} WHERE id=${id}`
        return yield* issue(yield* user(current.userId), id, next, now, idle, current.absoluteExpires)
      })
    )
  }, execute)
  const logout = Effect.fn("Auth.logout")(function* (actor: Actor) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* session(actor.sessionId, "update")
        if (current.userId !== actor.user.id) return yield* unauthorized()
        const now = yield* Clock.currentTimeMillis
        yield* sql`UPDATE sessions SET revoked_at=${iso(now)} WHERE id=${current.id}`
      })
    )
  }, execute)
  return { register, login, refresh, logout, authorize, lockActor, user }
})
export class Auth extends Context.Service<Auth, Effect.Success<typeof makeAuth>>()("sitetrack/Auth") {
  static readonly layer = Layer.effect(Auth, makeAuth)
}
