import { describe, expect, it } from "vitest"
import { Effect, Schema, Result } from "effect"
import * as M from "../../src/domain/models.js"
import * as T from "../../src/domain/task-models.js"
import { withApp, type TestApp, type Client } from "./app-fixture.js"
import { race } from "./race.js"

const input = { name: "Task", startDate: "2026-11-14", endDate: "2026-11-30" }
const options = { now: Date.parse("2026-11-14T20:30:00Z") }
const projectInput = { name: "Task Site", startDate: "2026-01-01", endDate: "2026-12-31" }
const root = (project: string) => `/api/v1/projects/${project}`
const taskPath = (project: string, id: string) => `${root(project)}/tasks/${id}`
const project = async (app: TestApp, actor: Client, name = "Task Site") => {
  const response = await app.request("POST", "/api/v1/projects", { ...projectInput, name }, actor)
  expect(response.status).toBe(201)
  return Schema.decodeUnknownSync(M.Project)(await response.json())
}
const task = async (app: TestApp, actor: Client, projectId: string, name = "Task") => {
  const response = await app.request("POST", `${root(projectId)}/tasks`, { ...input, name }, actor)
  expect(response.status).toBe(201)
  return Schema.decodeUnknownSync(T.TaskDetail)(await response.json())
}
const dependency = async (
  app: TestApp,
  actor: Client,
  projectId: string,
  dependent: string,
  prerequisite: string,
  status = 201
) => {
  const response = await app.request(
    "POST",
    `${taskPath(projectId, dependent)}/dependencies`,
    { prerequisiteTaskId: prerequisite },
    actor
  )
  expect(response.status).toBe(status)
  return response
}
const action = async (app: TestApp, actor: Client, projectId: string, id: string, name: string, status = 200) => {
  const response = await app.request("POST", `${taskPath(projectId, id)}/${name}`, {}, actor)
  expect(response.status).toBe(status)
  return response
}

describe("task workflows and graph contracts (ID/DAG/TASK/ACL)", () => {
  it("executes a diamond workflow, rejects illegal changes and preserves started history/IDs", async () => {
    await Effect.runPromise(
      withApp(async (app) => {
        const owner = await app.register("owner@example.test"),
          p = await project(app, owner)
        expect(p.taskCounts).toEqual({ total: 0, notStarted: 0, inProgress: 0, done: 0 })
        expect(p.completionPercentage).toBe(0)
        const a = await task(app, owner, p.id, "A"),
          b = await task(app, owner, p.id, "B"),
          c = await task(app, owner, p.id, "C"),
          d = await task(app, owner, p.id, "D")
        expect(a.id).toBe(`${p.id}-T-0001`)
        expect(a.allowedActions).toEqual(["start"])
        for (const [dependent, prerequisite] of [
          [b.id, a.id],
          [c.id, a.id],
          [d.id, b.id],
          [d.id, c.id],
          [d.id, a.id]
        ]) {
          if (dependent && prerequisite) await dependency(app, owner, p.id, dependent, prerequisite)
        }
        await dependency(app, owner, p.id, a.id, a.id, 409)
        await dependency(app, owner, p.id, a.id, d.id, 409)
        await dependency(app, owner, p.id, b.id, a.id, 409)
        const shortcut = Schema.decodeUnknownSync(M.collection(T.TaskRelation))(
          await (await app.request("GET", `${taskPath(p.id, d.id)}/prerequisites`, undefined, owner)).json()
        )
        expect(shortcut.items.map((x) => x.distance)).toEqual([1, 1, 1])
        expect(
          (await app.request("DELETE", `${taskPath(p.id, d.id)}/dependencies/${a.id}`, undefined, owner)).status
        ).toBe(204)
        const ancestry = Schema.decodeUnknownSync(M.collection(T.TaskRelation))(
          await (await app.request("GET", `${taskPath(p.id, d.id)}/prerequisites`, undefined, owner)).json()
        )
        expect(ancestry.items.find((x) => x.id === a.id)?.distance).toBe(2)
        await action(app, owner, p.id, d.id, "start", 409)
        await action(app, owner, p.id, a.id, "complete", 409)
        await action(app, owner, p.id, a.id, "reopen", 409)
        expect((await app.request("PATCH", taskPath(p.id, a.id), { status: "Done" }, owner)).status).toBe(400)
        expect((await app.request("PATCH", taskPath(p.id, a.id), { startDate: "2027-01-01" }, owner)).status).toBe(400)
        const started = Schema.decodeUnknownSync(T.TaskDetail)(
          await (await action(app, owner, p.id, a.id, "start")).json()
        )
        expect(started.firstStartedAt).toBe("2026-11-14T20:30:00.000Z")
        await action(app, owner, p.id, a.id, "start", 409)
        await action(app, owner, p.id, a.id, "complete")
        const summary = Schema.decodeUnknownSync(M.Project)(
          await (await app.request("GET", root(p.id), undefined, owner)).json()
        )
        expect(summary.taskCounts).toEqual({ total: 4, notStarted: 3, inProgress: 0, done: 1 })
        expect(summary.completionPercentage).toBe(25)
        expect(summary.blockedCount).toBe(1)
        await action(app, owner, p.id, b.id, "start")
        await action(app, owner, p.id, a.id, "reopen", 409)
        expect(
          (await app.request("DELETE", `${taskPath(p.id, b.id)}/dependencies/${a.id}`, undefined, owner)).status
        ).toBe(409)
        await dependency(app, owner, p.id, b.id, c.id, 409)
        await action(app, owner, p.id, b.id, "complete")
        await action(app, owner, p.id, c.id, "start")
        await action(app, owner, p.id, c.id, "complete")
        await action(app, owner, p.id, d.id, "start")
        await action(app, owner, p.id, d.id, "complete")
        await action(app, owner, p.id, a.id, "reopen", 409)
        expect((await app.request("DELETE", taskPath(p.id, a.id), undefined, owner)).status).toBe(409)
        for (const id of [d.id, c.id, b.id])
          expect((await app.request("DELETE", taskPath(p.id, id), undefined, owner)).status).toBe(204)
        const reopened = Schema.decodeUnknownSync(T.TaskDetail)(
          await (await action(app, owner, p.id, a.id, "reopen")).json()
        )
        expect(reopened.firstStartedAt).toBe(started.firstStartedAt)
        expect((await app.request("GET", taskPath(p.id, d.id), undefined, owner)).status).toBe(404)
        expect((await app.request("DELETE", taskPath(p.id, d.id), undefined, owner)).status).toBe(404)
        expect((await task(app, owner, p.id, "After deletion")).id).toBe(`${p.id}-T-0005`)
        const later = await app.request(
          "PATCH",
          taskPath(p.id, a.id),
          { name: "  Updated  ", startDate: "2027-01-01", endDate: "2027-02-01" },
          owner
        )
        expect(later.status).toBe(200)
        expect(Schema.decodeUnknownSync(T.TaskDetail)(await later.json()).name).toBe("Updated")
      }, options)
    )
  })
  it("filters and sorts current flags, ranges and scoped metadata using company today", async () => {
    await Effect.runPromise(
      withApp(async (app) => {
        const owner = await app.register("owner@example.test"),
          p = await project(app, owner)
        const a = await task(app, owner, p.id, "Zulu"),
          b = await task(app, owner, p.id, "alpha"),
          c = await task(app, owner, p.id, "Bravo")
        await app.request("PATCH", taskPath(p.id, b.id), { startDate: "2026-11-15" }, owner)
        await app.request("PATCH", taskPath(p.id, c.id), { startDate: "2026-11-01", endDate: "2026-11-14" }, owner)
        await action(app, owner, p.id, c.id, "start")
        await dependency(app, owner, p.id, b.id, a.id)
        const list = async (query: string) =>
          Schema.decodeUnknownSync(M.collection(T.Task))(
            await (await app.request("GET", `${root(p.id)}/tasks?${query}`, undefined, owner)).json()
          )
        expect((await list("status=NotStarted&late=false&blocked=true")).items.map((x) => x.id)).toEqual([b.id])
        expect((await list("fromDate=2026-11-30&toDate=2026-11-30")).pagination.total).toBe(2)
        expect((await list("search=BRAVO")).items.map((x) => x.id)).toEqual([c.id])
        expect((await list("sort=name")).items.map((x) => x.id)).toEqual([b.id, c.id, a.id])
        expect((await list("sort=dependentCount&direction=desc")).items[0]?.id).toBe(a.id)
        expect((await list("sort=endDate")).items[0]?.id).toBe(c.id)
        const beyond = await list("page=9&pageSize=1")
        expect(beyond.items).toEqual([])
        expect(beyond.pagination.total).toBe(3)
        for (const query of [
          "late=yes",
          "blocked=1",
          "fromDate=2026-12-01&toDate=2026-01-01",
          "status=Other",
          "sort=unknown",
          "unknown=true"
        ])
          expect((await app.request("GET", `${root(p.id)}/tasks?${query}`, undefined, owner)).status).toBe(400)
        const summary = Schema.decodeUnknownSync(M.Project)(
          await (await app.request("GET", root(p.id), undefined, owner)).json()
        )
        expect(summary.taskCounts).toEqual({ total: 3, notStarted: 2, inProgress: 1, done: 0 })
        expect(summary.lateCount).toBe(2)
        expect(summary.blockedCount).toBe(1)
        expect(
          Schema.decodeUnknownSync(M.collection(M.Project))(
            await (await app.request("GET", "/api/v1/projects?hasLate=true", undefined, owner)).json()
          ).pagination.total
        ).toBe(1)
        expect(
          Schema.decodeUnknownSync(M.collection(M.Project))(
            await (await app.request("GET", "/api/v1/projects?hasLate=false", undefined, owner)).json()
          ).pagination.total
        ).toBe(0)
        expect((await app.request("GET", "/api/v1/projects?hasLate=yes", undefined, owner)).status).toBe(400)
      }, options)
    )
  })
  it("enforces member/SuperAdmin access, path ownership and immediate revocation", async () => {
    await Effect.runPromise(
      withApp(async (app) => {
        const owner = await app.register("owner@example.test"),
          member = await app.register("member@example.test"),
          admin = await app.register("admin@example.test", "SuperAdmin"),
          manager = await app.register("manager@example.test", "CompanyStoreManager")
        const p = await project(app, owner),
          other = await project(app, manager),
          a = await task(app, owner, p.id),
          foreign = await task(app, manager, other.id)
        for (const actor of [member, manager])
          for (const suffix of [
            "/tasks",
            `/tasks/${a.id}`,
            `/tasks/${a.id}/prerequisites`,
            `/tasks/${a.id}/dependents`
          ]) {
            expect((await app.request("GET", `${root(p.id)}${suffix}`, undefined, actor)).status).toBe(404)
            expect((await app.request("GET", `/api/v1/projects/PRJ-9999${suffix}`, undefined, actor)).status).toBe(404)
          }
        expect((await app.request("POST", `${root(p.id)}/tasks`, input, member)).status).toBe(404)
        expect((await app.request("GET", taskPath(p.id, foreign.id), undefined, admin)).status).toBe(404)
        await dependency(app, owner, p.id, a.id, foreign.id, 404)
        const invitation = Schema.decodeUnknownSync(M.Invitation)(
          await (
            await app.request("POST", `${root(p.id)}/invitations`, { email: member.body.user.email }, owner)
          ).json()
        )
        expect((await app.request("POST", `/api/v1/invitations/${invitation.id}/accept`, {}, member)).status).toBe(200)
        await task(app, member, p.id, "Member-created")
        await task(app, admin, p.id, "SuperAdmin-created")
        await Effect.runPromise(app.sql`UPDATE users SET role='User' WHERE id=${admin.body.user.id}`)
        expect((await app.request("GET", `${root(p.id)}/tasks`, undefined, admin)).status).toBe(404)
        expect(
          (await app.request("DELETE", `${root(p.id)}/members/${member.body.user.id}`, undefined, owner)).status
        ).toBe(204)
        expect((await app.request("GET", `${root(p.id)}/tasks`, undefined, member)).status).toBe(404)
        const hidden = Schema.decodeUnknownSync(M.collection(M.Project))(
          await (await app.request("GET", "/api/v1/projects?hasLate=true&sort=lateCount", undefined, member)).json()
        )
        expect(hidden.items).toEqual([])
        expect(hidden.pagination.total).toBe(0)
        expect((await app.request("DELETE", root(p.id), undefined, owner)).status).toBe(204)
        expect((await app.request("GET", taskPath(p.id, a.id), undefined, owner)).status).toBe(404)
      }, options)
    )
  })
  it("allocates unique numeric IDs concurrently, grows past 9999 and enforces database constraints", async () => {
    await Effect.runPromise(
      withApp(async (app) => {
        const owner = await app.register("owner@example.test"),
          p = await project(app, owner),
          other = await project(app, owner)
        const replies = await Promise.all(
          Array.from({ length: 12 }, () => app.request("POST", `${root(p.id)}/tasks`, input, owner))
        )
        expect(replies.every((r) => r.status === 201)).toBe(true)
        const tasks = await Promise.all(
          replies.map(async (r) => Schema.decodeUnknownSync(T.TaskDetail)(await r.json()))
        )
        expect(new Set(tasks.map((t) => t.id)).size).toBe(12)
        const numeric = Schema.decodeUnknownSync(M.collection(T.Task))(
          await (await app.request("GET", `${root(p.id)}/tasks?sort=id`, undefined, owner)).json()
        )
        expect(numeric.items.map((t) => t.id)).toEqual(
          Array.from({ length: 12 }, (_, i) => `${p.id}-T-${String(i + 1).padStart(4, "0")}`)
        )
        expect((await task(app, owner, other.id)).id).toBe(`${other.id}-T-0001`)
        await Effect.runPromise(app.sql`UPDATE projects SET task_counter=9999 WHERE public_id=${p.id}`)
        expect((await task(app, owner, p.id)).id).toBe(`${p.id}-T-10000`)
        for (const query of [
          app.sql`INSERT INTO task_dependencies(project_id,dependent_id,prerequisite_id) SELECT d.project_id,d.id,r.id FROM tasks d CROSS JOIN tasks r WHERE d.public_id=${`${p.id}-T-0001`} AND r.public_id=${`${other.id}-T-0001`}`,
          app.sql`INSERT INTO task_dependencies(project_id,dependent_id,prerequisite_id) SELECT project_id,id,id FROM tasks WHERE public_id=${`${p.id}-T-0001`}`,
          app.sql`UPDATE tasks SET status='Done' WHERE public_id=${`${p.id}-T-0001`}`,
          app.sql`INSERT INTO tasks(id,project_id,task_number,public_id,name,start_date,end_date) SELECT gen_random_uuid(),project_id,task_number,'PRJ-9999-T-0001',name,start_date,end_date FROM tasks WHERE public_id=${`${p.id}-T-0001`}`
        ])
          expect(Result.isFailure(await Effect.runPromise(query.pipe(Effect.result)))).toBe(true)
        expect(await Effect.runPromise(app.sql`SELECT count(*)::int AS count FROM task_dependencies`)).toEqual([
          { count: 0 }
        ])
      }, options)
    )
  })
  it("serializes competing edge, status and deletion operations on separate connections", async () => {
    await Effect.runPromise(
      withApp(async (app) => {
        const owner = await app.register("owner@example.test"),
          p = await project(app, owner)
        const lock = app.sql`SELECT id FROM projects WHERE public_id=${p.id} FOR UPDATE`
        const a = await task(app, owner, p.id, "A"),
          b = await task(app, owner, p.id, "B")
        const opposite = await race(app.sql, lock, () => [
          app.request("POST", `${taskPath(p.id, a.id)}/dependencies`, { prerequisiteTaskId: b.id }, owner),
          app.request("POST", `${taskPath(p.id, b.id)}/dependencies`, { prerequisiteTaskId: a.id }, owner)
        ])
        expect(opposite.map((r) => r.status).sort((a, b) => a - b)).toEqual([201, 409])
        expect(await Effect.runPromise(app.sql`SELECT count(*)::int AS count FROM task_dependencies`)).toEqual([
          { count: 1 }
        ])
        const c = await task(app, owner, p.id, "C"),
          d = await task(app, owner, p.id, "D")
        const starting = await race(app.sql, lock, () => [
          app.request("POST", `${taskPath(p.id, c.id)}/start`, {}, owner),
          app.request("POST", `${taskPath(p.id, c.id)}/dependencies`, { prerequisiteTaskId: d.id }, owner)
        ])
        expect(starting.map((r) => r.status).sort((a, b) => a - b)).toEqual(
          starting[0]?.status === 200 ? [200, 409] : [201, 409]
        )
        const afterStart = Schema.decodeUnknownSync(T.TaskDetail)(
          await (await app.request("GET", taskPath(p.id, c.id), undefined, owner)).json()
        )
        expect(afterStart.status).toBe(starting[0]?.status === 200 ? "InProgress" : "NotStarted")
        expect(afterStart.blocked).toBe(starting[0]?.status !== 200)
        const e = await task(app, owner, p.id, "E"),
          f = await task(app, owner, p.id, "F")
        await dependency(app, owner, p.id, f.id, e.id)
        await action(app, owner, p.id, e.id, "start")
        await action(app, owner, p.id, e.id, "complete")
        const reopening = await race(app.sql, lock, () => [
          app.request("POST", `${taskPath(p.id, e.id)}/reopen`, {}, owner),
          app.request("POST", `${taskPath(p.id, f.id)}/start`, {}, owner)
        ])
        expect(reopening.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 409])
        const afterReopen = Schema.decodeUnknownSync(T.TaskDetail)(
          await (await app.request("GET", taskPath(p.id, e.id), undefined, owner)).json()
        )
        const afterDependent = Schema.decodeUnknownSync(T.TaskDetail)(
          await (await app.request("GET", taskPath(p.id, f.id), undefined, owner)).json()
        )
        expect([afterReopen.status, afterDependent.status]).toEqual(
          reopening[0]?.status === 200 ? ["InProgress", "NotStarted"] : ["Done", "InProgress"]
        )
        const g = await task(app, owner, p.id, "G"),
          h = await task(app, owner, p.id, "H")
        const deleting = await race(app.sql, lock, () => [
          app.request("DELETE", taskPath(p.id, g.id), undefined, owner),
          app.request("POST", `${taskPath(p.id, h.id)}/dependencies`, { prerequisiteTaskId: g.id }, owner)
        ])
        expect(deleting.map((r) => r.status)).toEqual(deleting[0]?.status === 204 ? [204, 404] : [409, 201])
        expect(
          await Effect.runPromise(
            app.sql`SELECT count(*)::int AS count FROM task_dependencies e JOIN tasks d ON d.id=e.dependent_id JOIN tasks r ON r.id=e.prerequisite_id WHERE d.deleted_at IS NOT NULL OR r.deleted_at IS NOT NULL`
          )
        ).toEqual([{ count: 0 }])
      }, options)
    )
  })
  it("rechecks membership when removal races a task mutation", async () => {
    await Effect.runPromise(
      withApp(async (app) => {
        const owner = await app.register("owner@example.test"),
          member = await app.register("member@example.test"),
          p = await project(app, owner)
        const invite = Schema.decodeUnknownSync(M.Invitation)(
          await (
            await app.request("POST", `${root(p.id)}/invitations`, { email: member.body.user.email }, owner)
          ).json()
        )
        await app.request("POST", `/api/v1/invitations/${invite.id}/accept`, {}, member)
        const outcomes = await race(
          app.sql,
          app.sql`SELECT id FROM projects WHERE public_id=${p.id} FOR UPDATE`,
          () => [
            app.request("DELETE", `${root(p.id)}/members/${member.body.user.id}`, undefined, owner),
            app.request("POST", `${root(p.id)}/tasks`, input, member)
          ]
        )
        expect(outcomes[0]?.status).toBe(204)
        expect([201, 404]).toContain(outcomes[1]?.status)
        expect((await app.request("GET", `${root(p.id)}/tasks`, undefined, member)).status).toBe(404)
      }, options)
    )
  })
  it("rechecks a changed role after waiting for the project lock", async () => {
    await Effect.runPromise(
      withApp(async (app) => {
        const owner = await app.register("owner@example.test"),
          admin = await app.register("admin@example.test", "SuperAdmin"),
          p = await project(app, owner)
        const outcomes = await race(
          app.sql,
          Effect.gen(function* () {
            yield* app.sql`SELECT id FROM projects WHERE public_id=${p.id} FOR UPDATE`
            yield* app.sql`UPDATE users SET role='User' WHERE id=${admin.body.user.id}`
          }),
          () => [1, 2].map(() => app.request("POST", `${root(p.id)}/tasks`, input, admin))
        )
        expect(outcomes.map((r) => r.status)).toEqual([404, 404])
        expect(await Effect.runPromise(app.sql`SELECT count(*)::int AS count FROM tasks`)).toEqual([{ count: 0 }])
      }, options)
    )
  })
  it("pages through a 3,000-task chain completely and permits creation beyond the target size", async () => {
    await Effect.runPromise(
      withApp(async (app) => {
        const owner = await app.register("owner@example.test"),
          p = await project(app, owner)
        await Effect.runPromise(app.sql`INSERT INTO tasks(id,project_id,task_number,public_id,name,start_date,end_date)
        SELECT gen_random_uuid(),p.id,n,p.public_id||'-T-'||lpad(n::text,4,'0'),'Task '||n,'2099-01-01','2099-12-31'
        FROM projects p CROSS JOIN generate_series(1,3000) n WHERE p.public_id=${p.id}`)
        await Effect.runPromise(app.sql`UPDATE projects SET task_counter=3000 WHERE public_id=${p.id}`)
        await Effect.runPromise(app.sql`INSERT INTO task_dependencies(project_id,dependent_id,prerequisite_id)
        SELECT d.project_id,d.id,r.id FROM tasks d JOIN tasks r ON r.project_id=d.project_id AND r.task_number=d.task_number-1 JOIN projects p ON p.id=d.project_id WHERE p.public_id=${p.id}`)
        const ids = new Set<string>()
        for (let page = 1; page <= 30; page++) {
          const found = Schema.decodeUnknownSync(M.collection(T.TaskRelation))(
            await (
              await app.request(
                "GET",
                `${taskPath(p.id, `${p.id}-T-3000`)}/prerequisites?page=${page}&pageSize=100`,
                undefined,
                owner
              )
            ).json()
          )
          expect(found.pagination.total).toBe(2999)
          for (const item of found.items) {
            ids.add(item.id)
            expect(item.distance).toBe(3000 - Number(item.id.split("-T-")[1]))
          }
        }
        expect(ids.size).toBe(2999)
        const summary = Schema.decodeUnknownSync(M.Project)(
          await (await app.request("GET", root(p.id), undefined, owner)).json()
        )
        expect(summary.taskCounts.total).toBe(3000)
        expect(summary.blockedCount).toBe(2999)
        expect((await task(app, owner, p.id, "Beyond verified target")).id).toBe(`${p.id}-T-3001`)
      }, options)
    )
  }, 45000)
  it("sorts project completion by unrounded ratio and supplies consistent empty-page metadata", async () => {
    await Effect.runPromise(
      withApp(async (app) => {
        const owner = await app.register("owner@example.test")
        await project(app, owner, "Ratio One")
        await project(app, owner, "Ratio Two")
        const ordered = Schema.decodeUnknownSync(
          Schema.Array(Schema.Struct({ id: Schema.String, publicId: Schema.String }))
        )(await Effect.runPromise(app.sql`SELECT id::text,public_id AS "publicId" FROM projects ORDER BY id`))
        for (const [index, p] of ordered.entries()) {
          const count = index === 0 ? 3000 : 2999
          await Effect.runPromise(app.sql`INSERT INTO tasks(id,project_id,task_number,public_id,name,start_date,end_date,status,first_started_at)
          SELECT gen_random_uuid(),${p.id},n,${p.publicId}||'-T-'||lpad(n::text,4,'0'),'Task '||n,'2099-01-01','2099-12-31',
          CASE WHEN n=1 THEN 'Done' ELSE 'NotStarted' END,CASE WHEN n=1 THEN '2026-11-14T00:00:00Z'::timestamptz ELSE NULL END FROM generate_series(1,${count}) n`)
          await Effect.runPromise(app.sql`UPDATE projects SET task_counter=${count} WHERE id=${p.id}`)
        }
        const response = Schema.decodeUnknownSync(M.collection(M.Project))(
          await (
            await app.request(
              "GET",
              "/api/v1/projects?search=Ratio&sort=completionPercentage&direction=desc",
              undefined,
              owner
            )
          ).json()
        )
        expect(response.items.map((p) => p.completionPercentage)).toEqual([0.03, 0.03])
        expect(response.items.map((p) => p.id)).toEqual([ordered[1]?.publicId, ordered[0]?.publicId])
        const empty = Schema.decodeUnknownSync(M.collection(M.Project))(
          await (await app.request("GET", "/api/v1/projects?hasLate=false&page=9&pageSize=1", undefined, owner)).json()
        )
        expect(empty.items).toEqual([])
        expect(empty.pagination.total).toBe(2)
      }, options)
    )
  })
})
