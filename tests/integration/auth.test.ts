import { describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"
import { ErrorBody } from "../../src/api/common.js"
import * as Model from "../../src/domain/models.js"
import { withApp, password } from "./app-fixture.js"
import { race } from "./race.js"
const error = async (response: Response) => Schema.decodeUnknownSync(ErrorBody)(await response.json())

describe("accounts and sessions (AUTH-01/02/03)", () => {
  it("registers each assignment role, normalizes identity, and keeps credentials out of responses", async () => {
    await Effect.runPromise(withApp(async ({ request }) => {
      for (const role of Model.Role.members.map((member) => member.literal)) {
        const response = await request("POST", "/api/v1/auth/register", { name: "  Person  ", email: `  ${role}@EXAMPLE.TEST  `, password, role })
        expect(response.status).toBe(201)
        const cookie = response.headers.get("set-cookie")
        expect(cookie).toContain("Max-Age=604800")
        expect(cookie).toContain("HttpOnly")
        expect(cookie).toContain("SameSite=Lax")
        expect(cookie).toContain("Path=/api/v1/auth")
        expect(response.headers.get("cache-control")).toBe("no-store")
        const text = await response.text()
        expect(text).not.toContain(password)
        expect(text).not.toMatch(/passwordHash|refreshToken/)
        const body = Schema.decodeUnknownSync(Model.SessionResult)(JSON.parse(text))
        expect(body.user).toMatchObject({ role, name: "Person", email: `${role.toLowerCase()}@example.test` })
        const profile = await request("GET", "/api/v1/me", undefined, { token: body.accessToken })
        expect(Schema.decodeUnknownSync(Model.User)(await profile.json())).toEqual(body.user)
      }
    }))
  })
  it("normalizes failed login and rejects malformed input without echoing passwords", async () => {
    await Effect.runPromise(withApp(async ({ request, register }) => {
      await register("member@example.test")
      const missing = await request("POST", "/api/v1/auth/login", { email: "missing@example.test", password })
      const wrong = await request("POST", "/api/v1/auth/login", { email: "member@example.test", password: "A wrong synthetic password!" })
      expect(missing.status).toBe(401); expect(wrong.status).toBe(401)
      expect(missing.headers.get("cache-control")).toBe("no-store")
      const unauthenticated = await request("GET", "/api/v1/me")
      expect(unauthenticated.status).toBe(401)
      expect((await error(unauthenticated)).requestId).toBe(unauthenticated.headers.get("x-request-id"))
      expect(await error(missing)).toMatchObject({ code: "INVALID_CREDENTIALS", message: "Invalid email or password." })
      expect(await error(wrong)).toMatchObject({ code: "INVALID_CREDENTIALS", message: "Invalid email or password." })
      const bad = await request("POST", "/api/v1/auth/register", { email: "bad", password: "SENSITIVE_SENTINEL", role: "root", name: "Person", extra: "no" })
      expect(bad.status).toBe(400)
      expect(await bad.text()).not.toContain("SENSITIVE_SENTINEL")
      const large = await request("POST", "/api/v1/auth/login", { email: "member@example.test", password: "x".repeat(17000) })
      expect(large.status).toBe(413)
    }))
  })
  it("enforces cookie/CSRF/CORS policy and retains curl support", async () => {
    await Effect.runPromise(withApp(async ({ request, register }) => {
      const actor = await register("browser@example.test")
      expect((await request("POST", "/api/v1/auth/refresh", {}, actor, { "X-CSRF-Protection": "" })).status).toBe(400)
      expect((await request("POST", "/api/v1/auth/refresh", {}, actor, { Origin: "https://untrusted.example" })).status).toBe(403)
      expect((await request("POST", "/api/v1/auth/refresh", {}, actor, { Origin: "null" })).status).toBe(403)
      const accepted = await request("POST", "/api/v1/auth/refresh", {}, actor, { Origin: "http://localhost:5173" })
      expect(accepted.status).toBe(200)
      expect(accepted.headers.get("access-control-allow-origin")).toBe("http://localhost:5173")
      expect(accepted.headers.get("access-control-allow-credentials")).toBe("true")
      expect((await request("GET", "/api/v1/me", undefined, { cookie: actor.cookie })).status).toBe(401)
      const preflight = await request("OPTIONS", "/api/v1/auth/login", undefined, {}, { Origin: "http://localhost:5173", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-csrf-protection" })
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:5173")
    }))
  })
  it("rotates refresh credentials and logout revokes only its own session", async () => {
    await Effect.runPromise(withApp(async ({ request, register, sql }) => {
      const a = await register("sessions@example.test")
      const login = await request("POST", "/api/v1/auth/login", { email: "sessions@example.test", password })
      const other = Schema.decodeUnknownSync(Model.SessionResult)(await login.json())
      const refreshed = await request("POST", "/api/v1/auth/refresh", {}, a)
      expect(refreshed.status).toBe(200)
      const body = Schema.decodeUnknownSync(Model.SessionResult)(await refreshed.json())
      const nextCookie = (refreshed.headers.get("set-cookie") ?? "").split(";")[0] ?? ""
      expect(nextCookie).not.toBe(a.cookie)
      expect((await request("POST", "/api/v1/auth/refresh", {}, a)).status).toBe(401)
      const loggedOut = await request("POST", "/api/v1/auth/logout", {}, { token: body.accessToken, cookie: nextCookie })
      expect(loggedOut.status).toBe(204)
      expect(loggedOut.headers.get("set-cookie")).toContain("Max-Age=0")
      expect((await request("GET", "/api/v1/me", undefined, a)).status).toBe(401)
      expect((await request("POST", "/api/v1/auth/refresh", {}, { cookie: nextCookie })).status).toBe(401)
      expect((await request("GET", "/api/v1/me", undefined, { token: other.accessToken })).status).toBe(200)
      const stored = await Effect.runPromise(sql`SELECT password_hash,refresh_hash FROM users JOIN sessions ON user_id=users.id WHERE email='sessions@example.test'`)
      expect(JSON.stringify(stored)).not.toContain(password)
      expect(JSON.stringify(stored)).not.toContain(a.cookie.slice(a.cookie.indexOf("=") + 1))
    }))
  })
  it("applies current roles and session deadlines to already issued access tokens", async () => {
    await Effect.runPromise(withApp(async ({ request, register, sql }) => {
      const a = await register("role@example.test")
      await Effect.runPromise(sql`UPDATE users SET role='SuperAdmin' WHERE id=${a.body.user.id}`)
      const profile = await request("GET", "/api/v1/me", undefined, a)
      expect(Schema.decodeUnknownSync(Model.User)(await profile.json()).role).toBe("SuperAdmin")
      await Effect.runPromise(sql`UPDATE sessions SET idle_expires_at=created_at WHERE user_id=${a.body.user.id}`)
      expect((await request("GET", "/api/v1/me", undefined, a)).status).toBe(401)
      expect((await request("POST", "/api/v1/auth/refresh", {}, a)).status).toBe(401)
    }))
  })
  it("serializes overlapping registration, refresh and logout requests", async () => {
    await Effect.runPromise(withApp(async ({ request, register, sql }) => {
      const registrations = await race(sql, sql`LOCK TABLE users IN SHARE MODE`, () => [1,2].map(() => request("POST", "/api/v1/auth/register", { name: "Concurrent", email: "duplicate@example.test", password, role: "User" })))
      expect(registrations.map((r) => r.status).sort()).toEqual([201,409])
      const a = await register("races@example.test")
      const sid = a.cookie.split("=")[1]?.slice(0,36)
      if (!sid) throw new Error("No session cookie")
      const refreshes = await race(sql, sql`SELECT id FROM sessions WHERE id=${sid} FOR UPDATE`, () => [1,2].map(() => request("POST", "/api/v1/auth/refresh", {}, a)))
      expect(refreshes.map((r) => r.status).sort()).toEqual([200,401])
      const winner = refreshes.find((r) => r.status === 200)
      if (!winner) throw new Error("No refresh winner")
      const cookie = (winner.headers.get("set-cookie") ?? "").split(";")[0] ?? ""
      const competed = await race(sql, sql`SELECT id FROM sessions WHERE id=${sid} FOR UPDATE`, () => [request("POST", "/api/v1/auth/refresh", {}, { cookie }), request("POST", "/api/v1/auth/logout", {}, a)])
      expect(competed[1]?.status).toBe(204)
      expect([200,401]).toContain(competed[0]?.status)
      expect((await request("GET", "/api/v1/me", undefined, a)).status).toBe(401)
      expect((await request("POST", "/api/v1/auth/refresh", {}, { cookie })).status).toBe(401)
    }))
  })
  it("caps refresh lifetime at absolute expiry and honors Secure-cookie configuration", async () => {
    await Effect.runPromise(withApp(async ({ request, register, sql }) => {
      const a = await register("expiry@example.test")
      const absolute = new Date(Date.now() + 3600000).toISOString()
      await Effect.runPromise(sql`UPDATE sessions SET idle_expires_at=${absolute},absolute_expires_at=${absolute} WHERE user_id=${a.body.user.id}`)
      const response = await request("POST", "/api/v1/auth/refresh", {}, a)
      expect(response.status).toBe(200)
      expect(response.headers.get("set-cookie")).toContain("Secure")
      const body = Schema.decodeUnknownSync(Model.SessionResult)(await response.json())
      expect(body.refreshExpiresAt).toBe(absolute)
      expect(body.sessionExpiresAt).toBe(absolute)
      const age = Number(/Max-Age=(\d+)/.exec(response.headers.get("set-cookie") ?? "")?.[1])
      expect(age).toBeGreaterThan(3500); expect(age).toBeLessThanOrEqual(3600)
      const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? ""
      await Effect.runPromise(sql`UPDATE sessions SET idle_expires_at=created_at,absolute_expires_at=created_at WHERE user_id=${a.body.user.id}`)
      expect((await request("POST", "/api/v1/auth/refresh", {}, { cookie })).status).toBe(401)
      expect((await request("GET", "/api/v1/me", undefined, { token: body.accessToken })).status).toBe(401)
    }, { secureCookie: true }))
  })
  it("throttles registrations before writing and ignores forged forwarded addresses", async () => {
    await Effect.runPromise(withApp(async ({ request, sql }) => {
      for (let i = 0; i < 5; i++) expect((await request("POST", "/api/v1/auth/register", { name: "Limited", email: `limit${i}@example.test`, password, role: "User" }, {}, { "X-Forwarded-For": `192.0.2.${i}` })).status).toBe(201)
      const blocked = await request("POST", "/api/v1/auth/register", { name: "Limited", email: "blocked@example.test", password, role: "User" }, {}, { "X-Forwarded-For": "192.0.2.100" })
      expect(blocked.status).toBe(429)
      expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0)
      expect(await Effect.runPromise(sql`SELECT count(*)::int AS count FROM users`)).toEqual([{ count: 5 }])
    }))
  })

})
