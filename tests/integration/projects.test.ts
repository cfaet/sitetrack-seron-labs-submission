import { describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"
import * as Model from "../../src/domain/models.js"
import { withApp } from "./app-fixture.js"
const input = { name: "Construction Site", startDate: "2026-01-01", endDate: "2026-12-31" }
describe("project access and identifiers (ACL-01/02, ID-01 project half)", () => {
  it("creates stores and first admins atomically, scopes lists and metadata, and hides nested resources", async () => {
    await Effect.runPromise(
      withApp(async ({ request, register, sql }) => {
        const owner = await register("owner@example.test"),
          outsider = await register("outsider@example.test"),
          superAdmin = await register("admin@example.test", "SuperAdmin"),
          manager = await register("manager@example.test", "CompanyStoreManager")
        const created = await request("POST", "/api/v1/projects", input, owner)
        expect(created.status).toBe(201)
        const project = Schema.decodeUnknownSync(Model.Project)(await created.json())
        expect(project).toMatchObject({ id: "PRJ-0001", isAdmin: true, memberCount: 1 })
        for (const actor of [outsider, manager]) {
          for (const suffix of ["", "/members", "/invitations"]) {
            const real = await request("GET", `/api/v1/projects/${project.id}${suffix}`, undefined, actor)
            const absent = await request("GET", `/api/v1/projects/PRJ-9999${suffix}`, undefined, actor)
            expect(real.status).toBe(404)
            expect(absent.status).toBe(404)
          }
          const list = Schema.decodeUnknownSync(Model.collection(Model.Project))(
            await (await request("GET", "/api/v1/projects?search=Construction", undefined, actor)).json()
          )
          expect(list.items).toEqual([])
          expect(list.pagination.total).toBe(0)
          expect(
            (await request("PATCH", `/api/v1/projects/${project.id}`, { name: "Hidden write" }, actor)).status
          ).toBe(404)
        }
        expect((await request("GET", `/api/v1/projects/${project.id}`, undefined, superAdmin)).status).toBe(200)
        expect(
          (await request("PATCH", `/api/v1/projects/${project.id}`, { name: "Admin bypass" }, superAdmin)).status
        ).toBe(403)
        expect(
          (
            await request(
              "POST",
              `/api/v1/projects/${project.id}/invitations`,
              { email: outsider.body.user.email },
              superAdmin
            )
          ).status
        ).toBe(403)
        expect((await request("GET", "/api/v1/projects?sort=unknown", undefined, owner)).status).toBe(400)
        expect((await request("GET", "/api/v1/projects?unknown=true", undefined, owner)).status).toBe(400)
        const beyond = Schema.decodeUnknownSync(Model.collection(Model.Project))(
          await (await request("GET", "/api/v1/projects?page=9&pageSize=1", undefined, owner)).json()
        )
        expect(beyond.items).toEqual([])
        expect(beyond.pagination.total).toBe(1)
        expect(
          await Effect.runPromise(sql`SELECT count(*)::int AS count FROM stores WHERE project_id IS NOT NULL`)
        ).toEqual([{ count: 1 }])
        await Effect.runPromise(sql`UPDATE users SET role='User' WHERE id=${superAdmin.body.user.id}`)
        expect((await request("GET", `/api/v1/projects/${project.id}`, undefined, superAdmin)).status).toBe(404)
        await Effect.runPromise(sql`UPDATE users SET role='SuperAdmin' WHERE id=${outsider.body.user.id}`)
        expect((await request("GET", `/api/v1/projects/${project.id}`, undefined, outsider)).status).toBe(200)
        const newlyVisible = Schema.decodeUnknownSync(Model.collection(Model.Project))(
          await (await request("GET", "/api/v1/projects", undefined, outsider)).json()
        )
        expect(newlyVisible.pagination.total).toBe(1)
      })
    )
  })
  it("validates merged patches, withdraws pending invitations on deletion and never reuses IDs", async () => {
    await Effect.runPromise(
      withApp(async ({ request, register, sql }) => {
        const owner = await register("owner@example.test"),
          invited = await register("invited@example.test")
        const created = Schema.decodeUnknownSync(Model.Project)(
          await (await request("POST", "/api/v1/projects", input, owner)).json()
        )
        expect(
          (await request("PATCH", `/api/v1/projects/${created.id}`, { startDate: "2027-01-01" }, owner)).status
        ).toBe(400)
        expect((await request("PATCH", `/api/v1/projects/${created.id}`, { id: "PRJ-9999" }, owner)).status).toBe(400)
        const invitation = Schema.decodeUnknownSync(Model.Invitation)(
          await (
            await request(
              "POST",
              `/api/v1/projects/${created.id}/invitations`,
              { email: invited.body.user.email },
              owner
            )
          ).json()
        )
        expect((await request("DELETE", `/api/v1/projects/${created.id}`, undefined, owner)).status).toBe(204)
        expect((await request("DELETE", `/api/v1/projects/${created.id}`, undefined, owner)).status).toBe(404)
        expect((await request("POST", `/api/v1/invitations/${invitation.id}/accept`, {}, invited)).status).toBe(409)
        const notes = Schema.decodeUnknownSync(Model.collection(Model.Notification))(
          await (await request("GET", "/api/v1/notifications", undefined, invited)).json()
        )
        expect(notes.items[0]?.allowedActions).toEqual([])
        const next = Schema.decodeUnknownSync(Model.Project)(
          await (await request("POST", "/api/v1/projects", input, owner)).json()
        )
        expect(next.id).toBe("PRJ-0002")
        await Effect.runPromise(sql`SELECT setval('project_number_seq',9999)`)
        const wide = Schema.decodeUnknownSync(Model.Project)(
          await (await request("POST", "/api/v1/projects", input, owner)).json()
        )
        expect(wide.id).toBe("PRJ-10000")
      })
    )
  })
  it("allocates unique project IDs across parallel connections", async () => {
    await Effect.runPromise(
      withApp(async ({ request, register, sql }) => {
        const owner = await register("owner@example.test")
        const responses = await Promise.all(
          Array.from({ length: 12 }, () => request("POST", "/api/v1/projects", input, owner))
        )
        expect(responses.every((response) => response.status === 201)).toBe(true)
        const projects = await Promise.all(
          responses.map(async (response) => Schema.decodeUnknownSync(Model.Project)(await response.json()))
        )
        expect(new Set(projects.map((project) => project.id)).size).toBe(12)
        expect(
          await Effect.runPromise(
            sql`SELECT count(*)::int AS count FROM projects p JOIN memberships m ON m.project_id=p.id JOIN stores s ON s.project_id=p.id WHERE m.is_admin`
          )
        ).toEqual([{ count: 12 }])
      })
    )
  })
})
