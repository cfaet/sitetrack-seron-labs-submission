import { describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"
import * as Model from "../../src/domain/models.js"
import { withApp } from "./app-fixture.js"
import { race } from "./race.js"
const projectInput = { name: "Team Site", startDate: "2026-01-01", endDate: "2026-12-31" }
describe("teams, invitations and notifications (INV-01, MEM-01, ACL)", () => {
  it("keeps invitations recipient-scoped, joins only after acceptance, and immediately removes access", async () => {
    await Effect.runPromise(withApp(async ({ request, register }) => {
      const owner = await register("owner@example.test"), invitee = await register("invitee@example.test"), outsider = await register("outsider@example.test")
      const project = Schema.decodeUnknownSync(Model.Project)(await (await request("POST", "/api/v1/projects", projectInput, owner)).json())
      expect((await request("POST", `/api/v1/projects/${project.id}/invitations`, { email: owner.body.user.email }, owner)).status).toBe(409)
      const invited = await request("POST", `/api/v1/projects/${project.id}/invitations`, { email: invitee.body.user.email }, owner)
      expect(invited.status).toBe(201)
      const invitation = Schema.decodeUnknownSync(Model.Invitation)(await invited.json())
      expect((await request("POST", `/api/v1/projects/${project.id}/invitations`, { email: invitee.body.user.email }, owner)).status).toBe(409)
      expect((await request("GET", `/api/v1/projects/${project.id}`, undefined, invitee)).status).toBe(404)
      const notifications = Schema.decodeUnknownSync(Model.collection(Model.Notification))(await (await request("GET", "/api/v1/notifications", undefined, invitee)).json())
      const hiddenNotes = Schema.decodeUnknownSync(Model.collection(Model.Notification))(await (await request("GET", "/api/v1/notifications", undefined, outsider)).json())
      expect(hiddenNotes.items).toEqual([]); expect(hiddenNotes.pagination.total).toBe(0)
      const notification = notifications.items[0]
      if (!notification) throw new Error("Missing invitation notification")
      expect(notification.allowedActions).toEqual(["accept","reject"])
      expect(await (await request("GET", "/api/v1/notifications/unread-count", undefined, invitee)).json()).toEqual({ count: 1 })
      expect(await (await request("GET", "/api/v1/notifications/unread-count", undefined, outsider)).json()).toEqual({ count: 0 })
      expect((await request("POST", `/api/v1/notifications/${notification.id}/read`, {}, outsider)).status).toBe(404)
      expect((await request("POST", `/api/v1/invitations/${invitation.id}/accept`, {}, outsider)).status).toBe(404)
      expect((await request("POST", `/api/v1/invitations/${invitation.id}/accept`, {}, invitee)).status).toBe(200)
      expect((await request("POST", `/api/v1/invitations/${invitation.id}/accept`, {}, invitee)).status).toBe(409)
      expect((await request("GET", `/api/v1/projects/${project.id}`, undefined, invitee)).status).toBe(200)
      expect(await (await request("GET", "/api/v1/notifications/unread-count", undefined, invitee)).json()).toEqual({ count: 0 })
      expect((await request("POST", `/api/v1/projects/${project.id}/invitations`, { email: outsider.body.user.email }, invitee)).status).toBe(403)
      expect((await request("PATCH", `/api/v1/projects/${project.id}/members/${invitee.body.user.id}`, { isAdmin: true }, owner)).status).toBe(200)
      expect((await request("PATCH", `/api/v1/projects/${project.id}/members/${invitee.body.user.id}`, { isAdmin: false }, owner)).status).toBe(200)
      expect((await request("DELETE", `/api/v1/projects/${project.id}/members/${invitee.body.user.id}`, undefined, owner)).status).toBe(204)
      expect((await request("GET", `/api/v1/projects/${project.id}`, undefined, invitee)).status).toBe(404)
      const scoped = Schema.decodeUnknownSync(Model.collection(Model.Project))(await (await request("GET", "/api/v1/projects", undefined, invitee)).json())
      expect(scoped.pagination.total).toBe(0)
    }))
  })
  it("keeps read status independent and checks invitations belong to the path project", async () => {
    await Effect.runPromise(withApp(async ({ request, register }) => {
      const owner = await register("owner@example.test"), invitee = await register("invitee@example.test")
      const a = Schema.decodeUnknownSync(Model.Project)(await (await request("POST", "/api/v1/projects", projectInput, owner)).json())
      const b = Schema.decodeUnknownSync(Model.Project)(await (await request("POST", "/api/v1/projects", projectInput, owner)).json())
      const invitation = Schema.decodeUnknownSync(Model.Invitation)(await (await request("POST", `/api/v1/projects/${a.id}/invitations`, { email: invitee.body.user.email }, owner)).json())
      expect((await request("POST", `/api/v1/projects/${b.id}/invitations/${invitation.id}/withdraw`, {}, owner)).status).toBe(404)
      const notes = Schema.decodeUnknownSync(Model.collection(Model.Notification))(await (await request("GET", "/api/v1/notifications", undefined, invitee)).json())
      const id = notes.items[0]?.id
      if (!id) throw new Error("Missing notification")
      const first = await (await request("POST", `/api/v1/notifications/${id}/read`, {}, invitee)).json()
      expect(await (await request("POST", `/api/v1/notifications/${id}/read`, {}, invitee)).json()).toEqual(first)
      expect((await request("POST", `/api/v1/invitations/${invitation.id}/reject`, {}, invitee)).status).toBe(200)
      expect((await request("GET", `/api/v1/projects/${a.id}`, undefined, invitee)).status).toBe(404)
      const again = Schema.decodeUnknownSync(Model.Invitation)(await (await request("POST", `/api/v1/projects/${a.id}/invitations`, { email: invitee.body.user.email }, owner)).json())
      expect((await request("POST", `/api/v1/projects/${a.id}/invitations/${again.id}/withdraw`, {}, owner)).status).toBe(200)
      expect(await (await request("GET", "/api/v1/notifications/unread-count", undefined, invitee)).json()).toEqual({ count: 1 })
    }))
  })
  it("has one acceptance/withdrawal winner with deliberate database overlap", async () => {
    await Effect.runPromise(withApp(async ({ request, register, sql }) => {
      const owner = await register("owner@example.test"), invitee = await register("invitee@example.test")
      const project = Schema.decodeUnknownSync(Model.Project)(await (await request("POST", "/api/v1/projects", projectInput, owner)).json())
      const invitation = Schema.decodeUnknownSync(Model.Invitation)(await (await request("POST", `/api/v1/projects/${project.id}/invitations`, { email: invitee.body.user.email }, owner)).json())
      const responses = await race(sql, sql`SELECT id FROM projects WHERE public_id=${project.id} FOR UPDATE`, () => [request("POST", `/api/v1/invitations/${invitation.id}/accept`, {}, invitee), request("POST", `/api/v1/projects/${project.id}/invitations/${invitation.id}/withdraw`, {}, owner)])
      expect(responses.map((r) => r.status).sort()).toEqual([200,409])
      const outcome = await Effect.runPromise(sql`SELECT status FROM invitations WHERE id=${invitation.id}`)
      const members = await Effect.runPromise(sql`SELECT count(*)::int AS count FROM memberships WHERE user_id=${invitee.body.user.id}`)
      expect(members).toEqual([{ count: outcome[0]?.status === "Accepted" ? 1 : 0 }])
    }))
  })
  it("cannot lose its last admin during competing demotions/removals", async () => {
    await Effect.runPromise(withApp(async ({ request, register, sql }) => {
      const owner = await register("owner@example.test"), second = await register("second@example.test")
      const project = Schema.decodeUnknownSync(Model.Project)(await (await request("POST", "/api/v1/projects", projectInput, owner)).json())
      expect((await request("DELETE", `/api/v1/projects/${project.id}/members/${owner.body.user.id}`, undefined, owner)).status).toBe(409)
      const invitation = Schema.decodeUnknownSync(Model.Invitation)(await (await request("POST", `/api/v1/projects/${project.id}/invitations`, { email: second.body.user.email }, owner)).json())
      await request("POST", `/api/v1/invitations/${invitation.id}/accept`, {}, second)
      await request("PATCH", `/api/v1/projects/${project.id}/members/${second.body.user.id}`, { isAdmin: true }, owner)
      const responses = await race(sql, sql`SELECT id FROM projects WHERE public_id=${project.id} FOR UPDATE`, () => [owner,second].map((actor) => request("PATCH", `/api/v1/projects/${project.id}/members/${actor.body.user.id}`, { isAdmin: false }, actor)))
      expect(responses.map((r) => r.status).sort()).toEqual([200,409])
      expect(await Effect.runPromise(sql`SELECT count(*)::int AS count FROM memberships WHERE is_admin`)).toEqual([{ count: 1 }])
      const remaining = await Effect.runPromise(sql`SELECT user_id::text AS id FROM memberships WHERE is_admin`)
      const administrator = remaining[0]?.id === owner.body.user.id ? owner : second
      expect((await request("PATCH", `/api/v1/projects/${project.id}/members/${owner.body.user.id}`, { isAdmin: true }, administrator)).status).toBe(200)
      expect((await request("PATCH", `/api/v1/projects/${project.id}/members/${second.body.user.id}`, { isAdmin: true }, administrator)).status).toBe(200)
      const removals = await race(sql, sql`SELECT id FROM projects WHERE public_id=${project.id} FOR UPDATE`, () => [owner,second].map((actor) => request("DELETE", `/api/v1/projects/${project.id}/members/${actor.body.user.id}`, undefined, actor)))
      expect(removals.map((r) => r.status).sort()).toEqual([204,409])
      expect(await Effect.runPromise(sql`SELECT count(*)::int AS count FROM memberships WHERE is_admin`)).toEqual([{ count: 1 }])
    }))
  })
})
