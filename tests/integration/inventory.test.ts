import { describe, expect, it } from "vitest"
import { Effect, Result, Schema } from "effect"
import { randomUUID } from "node:crypto"
import * as M from "../../src/domain/inventory-models.js"
import * as Core from "../../src/domain/models.js"
import { withApp, password, type TestApp, type Client } from "./app-fixture.js"
import { race } from "./race.js"

const materials = "/api/v1/materials",
  company = "/api/v1/company-store"
const projectPath = (id: string) => `/api/v1/projects/${id}`
const deliveryPath = (id: string) => `/api/v1/deliveries/${id}`
const headers = (key: string) => ({ "Idempotency-Key": key })
const makeMaterial = async (app: TestApp, actor: Client, name = "Cement", category = "Masonry", unit = "kg") => {
  const response = await app.request("POST", materials, { name, category, unit }, actor)
  expect(response.status).toBe(201)
  return Schema.decodeUnknownSync(M.Material)(await response.json())
}
const makeProject = async (app: TestApp, actor: Client, name = "Site") => {
  const response = await app.request(
    "POST",
    "/api/v1/projects",
    { name, startDate: "2026-01-01", endDate: "2026-12-31" },
    actor
  )
  expect(response.status).toBe(201)
  return Schema.decodeUnknownSync(Core.Project)(await response.json())
}
const add = async (app: TestApp, actor: Client, materialId: string, quantity: string, key?: string) => {
  const response = await app.request(
    "POST",
    `${company}/stock/additions`,
    { materialId, quantity },
    actor,
    key === undefined ? {} : headers(key)
  )
  expect(response.status).toBe(201)
  return Schema.decodeUnknownSync(M.StockAddition)(await response.json())
}
const send = async (
  app: TestApp,
  actor: Client,
  projectId: string,
  lines: (typeof M.DeliveryInput.Type)["lines"],
  key?: string,
  returning = false
) => {
  const response = await app.request(
    "POST",
    returning ? `${projectPath(projectId)}/deliveries` : `${company}/deliveries`,
    returning ? { lines } : { projectId, lines },
    actor,
    key === undefined ? {} : headers(key)
  )
  expect(response.status).toBe(201)
  return Schema.decodeUnknownSync(M.Delivery)(await response.json())
}
const act = async (app: TestApp, actor: Client, id: string, action: M.DeliveryAction, key?: string) => {
  const response = await app.request(
    "POST",
    `${deliveryPath(id)}/${action}`,
    {},
    actor,
    key === undefined ? {} : headers(key)
  )
  expect(response.status).toBe(200)
  return Schema.decodeUnknownSync(M.Delivery)(await response.json())
}
const companyRows = async (app: TestApp, actor: Client, query = "") => {
  const response = await app.request("GET", `${company}/stock${query}`, undefined, actor)
  expect(response.status).toBe(200)
  return Schema.decodeUnknownSync(Core.collection(M.CompanyStock))(await response.json())
}
const projectRows = async (app: TestApp, actor: Client, id: string, query = "") => {
  const response = await app.request("GET", `${projectPath(id)}/store${query}`, undefined, actor)
  expect(response.status).toBe(200)
  return Schema.decodeUnknownSync(Core.collection(M.ProjectStock))(await response.json())
}
const conserved = async (app: TestApp) => {
  const result = await Effect.runPromise(app.sql`SELECT
    NOT EXISTS(SELECT 1 FROM stock_balances b LEFT JOIN (SELECT store_id,material_id,sum(delta) AS quantity FROM stock_movements GROUP BY store_id,material_id) m
      ON m.store_id=b.store_id AND m.material_id=b.material_id WHERE b.quantity<>coalesce(m.quantity,0)) AS balances,
    NOT EXISTS(SELECT 1 FROM materials m WHERE
      coalesce((SELECT sum(delta) FROM stock_movements WHERE material_id=m.id AND kind='Addition'),0)<>
      coalesce((SELECT sum(quantity) FROM stock_balances WHERE material_id=m.id),0)+
      coalesce((SELECT sum(l.quantity) FROM delivery_lines l JOIN deliveries d ON d.id=l.delivery_id WHERE l.material_id=m.id AND d.status='InTransit'),0)) AS conservation`)
  expect(result).toEqual([{ balances: true, conservation: true }])
}

describe("inventory and deliveries (STOCK/DEL/DELETE)", () => {
  it("rechecks membership when removal competes with project-store dispatch", async () => {
    await Effect.runPromise(
      withApp(async (app) => {
        const owner = await app.register("owner@example.test"),
          member = await app.register("member@example.test"),
          manager = await app.register("manager@example.test", "CompanyStoreManager")
        const material = await makeMaterial(app, owner),
          project = await makeProject(app, owner)
        const invite = Schema.decodeUnknownSync(Core.Invitation)(
          await (
            await app.request(
              "POST",
              `${projectPath(project.id)}/invitations`,
              { email: member.body.user.email },
              owner
            )
          ).json()
        )
        expect((await app.request("POST", `/api/v1/invitations/${invite.id}/accept`, {}, member)).status).toBe(200)
        await add(app, manager, material.id, "2")
        const incoming = await send(app, manager, project.id, [{ materialId: material.id, quantity: "2" }])
        await act(app, owner, incoming.id, "record")
        const outcomes = await race(
          app.sql,
          app.sql`SELECT id FROM projects WHERE public_id=${project.id} FOR UPDATE`,
          () => [
            app.request("DELETE", `${projectPath(project.id)}/members/${member.body.user.id}`, undefined, owner),
            app.request(
              "POST",
              `${projectPath(project.id)}/deliveries`,
              { lines: [{ materialId: material.id, quantity: "1" }] },
              member,
              headers("membership-race")
            )
          ]
        )
        expect(outcomes[0]?.status).toBe(204)
        expect([201, 404]).toContain(outcomes[1]?.status)
        expect(
          (
            await app.request(
              "POST",
              `${projectPath(project.id)}/deliveries`,
              { lines: [{ materialId: material.id, quantity: "1" }] },
              member,
              headers("membership-race")
            )
          ).status
        ).toBe(404)
        await conserved(app)
      })
    )
  })
  it("enforces finite balances, immutable-line uniqueness and terminal movement/metadata constraints", async () => {
    await Effect.runPromise(
      withApp(async (app) => {
        const manager = await app.register("manager@example.test", "CompanyStoreManager")
        const material = await makeMaterial(app, manager),
          project = await makeProject(app, manager)
        await add(app, manager, material.id, "1")
        const delivery = await send(app, manager, project.id, [{ materialId: material.id, quantity: "0.5" }])
        for (const query of [
          app.sql`UPDATE stock_balances SET quantity=-1 WHERE material_id=${material.id}`,
          app.sql`UPDATE stock_balances SET quantity='NaN'::numeric WHERE material_id=${material.id}`,
          app.sql`UPDATE stock_balances SET reorder_point='NaN'::numeric WHERE material_id=${material.id}`,
          app.sql`UPDATE delivery_lines SET quantity=0 WHERE delivery_id=${delivery.id}`,
          app.sql`UPDATE delivery_lines SET quantity='NaN'::numeric WHERE delivery_id=${delivery.id}`,
          app.sql`UPDATE deliveries SET status='Delivered' WHERE id=${delivery.id}`,
          app.sql`INSERT INTO delivery_lines SELECT * FROM delivery_lines WHERE delivery_id=${delivery.id}`,
          app.sql`INSERT INTO stock_movements(id,store_id,material_id,delta,kind,delivery_id,phase,actor_id,created_at)
          SELECT ${randomUUID()},store_id,material_id,delta,kind,delivery_id,phase,actor_id,created_at FROM stock_movements WHERE delivery_id=${delivery.id}`,
          app.sql`INSERT INTO stock_movements(id,store_id,material_id,delta,kind,delivery_id,phase,actor_id,created_at)
          SELECT ${randomUUID()},store_id,material_id,0.1,'Receipt',delivery_id,NULL,actor_id,created_at FROM stock_movements WHERE delivery_id=${delivery.id}`
        ])
          expect(Result.isFailure(await Effect.runPromise(query.pipe(Effect.result)))).toBe(true)
        expect((await companyRows(app, manager)).items[0]?.quantity).toBe("0.5")
        await conserved(app)
      })
    )
  })
  it("rejects overflow atomically for additions, receipts and refunds, and keeps aggregate quantities exact", async () => {
    await Effect.runPromise(
      withApp(async (app) => {
        const owner = await app.register("owner@example.test"),
          manager = await app.register("manager@example.test", "CompanyStoreManager")
        const material = await makeMaterial(app, owner, "Bounded"),
          project = await makeProject(app, owner)
        const maximum = "99999999999999.999999"
        await add(app, manager, material.id, maximum)
        expect(
          (
            await app.request(
              "POST",
              `${company}/stock/additions`,
              { materialId: material.id, quantity: "0.000001" },
              manager
            )
          ).status
        ).toBe(409)
        const initial = await send(app, manager, project.id, [{ materialId: material.id, quantity: "1" }])
        await add(app, manager, material.id, "1")
        await act(app, owner, initial.id, "record")
        const returning = await send(
          app,
          owner,
          project.id,
          [{ materialId: material.id, quantity: "1" }],
          undefined,
          true
        )
        expect(
          (await app.request("POST", `${deliveryPath(returning.id)}/record`, {}, manager, headers("overflow-record")))
            .status
        ).toBe(409)
        expect(
          await Effect.runPromise(
            app.sql`SELECT count(*)::int AS count FROM idempotency_records WHERE key='overflow-record'`
          )
        ).toEqual([{ count: 0 }])
        expect(
          Schema.decodeUnknownSync(M.Delivery)(
            await (await app.request("GET", deliveryPath(returning.id), undefined, owner)).json()
          ).status
        ).toBe("InTransit")
        await act(app, owner, returning.id, "cancel")
        const refundable = await send(app, manager, project.id, [{ materialId: material.id, quantity: "1" }])
        await add(app, manager, material.id, "1")
        for (const [actor, action] of [
          [owner, "reject"],
          [manager, "cancel"]
        ] as const)
          expect((await app.request("POST", `${deliveryPath(refundable.id)}/${action}`, {}, actor)).status).toBe(409)
        expect((await companyRows(app, manager)).items[0]?.quantity).toBe(maximum)
        await act(app, owner, refundable.id, "record")
        expect((await projectRows(app, owner, project.id)).items[0]?.quantity).toBe("2")
        const aggregate = await makeMaterial(app, owner, "Aggregate")
        await add(app, manager, aggregate.id, maximum)
        const first = await send(app, manager, project.id, [{ materialId: aggregate.id, quantity: maximum }])
        await add(app, manager, aggregate.id, maximum)
        const second = await send(app, manager, project.id, [{ materialId: aggregate.id, quantity: maximum }])
        expect((await companyRows(app, manager, "?search=Aggregate")).items[0]?.inTransitQuantity).toBe(
          "199999999999999.999998"
        )
        await act(app, manager, first.id, "cancel")
        expect((await app.request("POST", `${deliveryPath(second.id)}/cancel`, {}, manager)).status).toBe(409)
        await act(app, owner, second.id, "record")
        await conserved(app)
      })
    )
  })
  it("scopes company/project projections, filters, metadata and action permissions", async () => {
    await Effect.runPromise(
      withApp(
        async (app) => {
          const owner = await app.register("owner@example.test"),
            manager = await app.register("manager@example.test", "CompanyStoreManager"),
            outsider = await app.register("outsider@example.test"),
            admin = await app.register("admin@example.test", "SuperAdmin")
          const a = await makeMaterial(app, owner, "Alpha", "Stone"),
            b = await makeMaterial(app, owner, "Beta", "Steel"),
            unused = await makeMaterial(app, owner, "Zero", "Stone")
          const one = await makeProject(app, owner, "One"),
            two = await makeProject(app, outsider, "Two")
          await add(app, manager, a.id, "2")
          await add(app, manager, b.id, "1")
          await app.request("PUT", `${company}/stock/${b.id}/reorder-point`, { reorderPoint: "1" }, manager)
          expect((await companyRows(app, manager, "?sort=status")).items.map((row) => row.status)).toEqual([
            "OutOfStock",
            "LowStock",
            "Available"
          ])
          const low = await companyRows(app, manager, "?status=LowStock&category=steel&search=BET&pageSize=1")
          expect(low.pagination.total).toBe(1)
          expect(low.items[0]?.material.id).toBe(b.id)
          const empty = await companyRows(app, manager, "?category=stone&page=9&pageSize=1")
          expect(empty.items).toEqual([])
          expect(empty.pagination.total).toBe(2)
          expect((await app.request("GET", `${company}/stock`, undefined, owner)).status).toBe(403)
          expect(
            (
              await app.request(
                "POST",
                `${company}/deliveries`,
                { projectId: one.id, lines: [{ materialId: a.id, quantity: "1" }] },
                owner
              )
            ).status
          ).toBe(403)
          const delivery = await send(app, manager, one.id, [{ materialId: a.id, quantity: "1" }])
          await send(app, manager, two.id, [{ materialId: b.id, quantity: "1" }])
          expect((await app.request("GET", projectPath(one.id), undefined, manager)).status).toBe(404)
          for (const suffix of ["/tasks", "/members", "/store", "/deliveries"])
            expect((await app.request("GET", `${projectPath(one.id)}${suffix}`, undefined, manager)).status).toBe(404)
          for (const id of [one.id, "PRJ-999999"])
            expect((await app.request("GET", `${projectPath(id)}/deliveries`, undefined, outsider)).status).toBe(404)
          expect((await app.request("GET", deliveryPath(delivery.id), undefined, outsider)).status).toBe(404)
          expect((await app.request("GET", deliveryPath(randomUUID()), undefined, outsider)).status).toBe(404)
          expect((await app.request("POST", `${deliveryPath(delivery.id)}/record`, {}, manager)).status).toBe(403)
          expect((await app.request("POST", `${deliveryPath(delivery.id)}/cancel`, {}, owner)).status).toBe(403)
          const companyList = await app.request(
            "GET",
            `${company}/deliveries?projectId=${one.id}&direction=CompanyToProject&status=InTransit&fromDate=2026-11-15&toDate=2026-11-15`,
            undefined,
            manager
          )
          expect(companyList.status).toBe(200)
          const companyText = await companyList.text()
          expect(companyText).not.toMatch(/taskCounts|memberCount|email|invitations/)
          expect(Schema.decodeUnknownSync(Core.collection(M.Delivery))(JSON.parse(companyText)).pagination.total).toBe(
            1
          )
          const scoped = Schema.decodeUnknownSync(Core.collection(M.Delivery))(
            await (
              await app.request("GET", `${projectPath(one.id)}/deliveries?page=9&pageSize=1`, undefined, owner)
            ).json()
          )
          expect(scoped.items).toEqual([])
          expect(scoped.pagination.total).toBe(1)
          await act(app, admin, delivery.id, "record")
          expect(
            (await projectRows(app, owner, one.id, "?search=alp&category=STONE&sort=lastDelivery&direction=desc"))
              .items[0]?.quantity
          ).toBe("1")
          expect((await projectRows(app, owner, one.id, "?category=Steel")).pagination.total).toBe(0)
          for (const query of [
            "status=Other",
            "direction=Incoming",
            "fromDate=2026-12-01&toDate=2026-01-01",
            "unknown=true"
          ])
            expect((await app.request("GET", `${company}/deliveries?${query}`, undefined, manager)).status).toBe(400)
          const preflight = await app.request(
            "OPTIONS",
            `${company}/stock/${unused.id}/reorder-point`,
            undefined,
            {},
            {
              Origin: "http://localhost:5173",
              "Access-Control-Request-Method": "PUT",
              "Access-Control-Request-Headers": "authorization,content-type,idempotency-key"
            }
          )
          expect(preflight.status).toBe(204)
          expect(preflight.headers.get("access-control-allow-methods")).toContain("PUT")
          expect(preflight.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("idempotency-key")
          await conserved(app)
        },
        { now: Date.parse("2026-11-15T23:59:59.999Z") }
      )
    )
  })
  it("coordinates simultaneous company withdrawals across different projects and absent stock rows", async () => {
    await Effect.runPromise(
      withApp(async (app) => {
        const manager = await app.register("manager@example.test", "CompanyStoreManager")
        const material = await makeMaterial(app, manager),
          one = await makeProject(app, manager, "One"),
          two = await makeProject(app, manager, "Two")
        const additions = await race(
          app.sql,
          app.sql`SELECT id FROM materials WHERE id=${material.id} FOR UPDATE`,
          () =>
            ["1", "2"].map((quantity) =>
              app.request("POST", `${company}/stock/additions`, { materialId: material.id, quantity }, manager)
            )
        )
        expect(additions.map((response) => response.status)).toEqual([201, 201])
        expect((await companyRows(app, manager)).items[0]?.quantity).toBe("3")
        const withdrawals = await race(
          app.sql,
          app.sql`SELECT store_id FROM stock_balances WHERE material_id=${material.id} FOR UPDATE`,
          () =>
            [one, two].map((project) =>
              app.request(
                "POST",
                `${company}/deliveries`,
                { projectId: project.id, lines: [{ materialId: material.id, quantity: "2" }] },
                manager
              )
            )
        )
        expect(withdrawals.map((response) => response.status).sort((a, b) => a - b)).toEqual([201, 409])
        expect((await companyRows(app, manager)).items[0]?.quantity).toBe("1")
        expect(await Effect.runPromise(app.sql`SELECT count(*)::int AS count FROM deliveries`)).toEqual([{ count: 1 }])
        await conserved(app)
      })
    )
  })
  it("serializes terminal races and same-key retries on separate connections", async () => {
    await Effect.runPromise(
      withApp(async (app) => {
        const owner = await app.register("owner@example.test"),
          manager = await app.register("manager@example.test", "CompanyStoreManager")
        const material = await makeMaterial(app, owner),
          project = await makeProject(app, owner)
        await add(app, manager, material.id, "10")
        const same = await race(
          app.sql,
          app.sql`SELECT store_id FROM stock_balances WHERE material_id=${material.id} FOR UPDATE`,
          () =>
            [1, 2].map(() =>
              app.request(
                "POST",
                `${company}/stock/additions`,
                { materialId: material.id, quantity: "1" },
                manager,
                headers("same-add")
              )
            )
        )
        expect(same.map((response) => response.status)).toEqual([201, 201])
        expect(await same[0]?.json()).toEqual(await same[1]?.json())
        expect((await companyRows(app, manager)).items[0]?.quantity).toBe("11")
        const secondManager = await app.register("other-manager@example.test", "CompanyStoreManager")
        await add(app, secondManager, material.id, "1", "same-add")
        expect((await companyRows(app, manager)).items[0]?.quantity).toBe("12")
        const different = await race(
          app.sql,
          app.sql`SELECT store_id FROM stock_balances WHERE material_id=${material.id} FOR UPDATE`,
          () =>
            ["1", "2"].map((quantity) =>
              app.request(
                "POST",
                `${company}/stock/additions`,
                { materialId: material.id, quantity },
                manager,
                headers("different-add")
              )
            )
        )
        expect(different.map((response) => response.status).sort((a, b) => a - b)).toEqual([201, 409])
        for (const pair of [
          ["record", "cancel"],
          ["record", "reject"],
          ["reject", "cancel"]
        ] as const) {
          const sent = await send(app, manager, project.id, [{ materialId: material.id, quantity: "1" }])
          const outcomes = await race(
            app.sql,
            app.sql`SELECT id FROM projects WHERE public_id=${project.id} FOR UPDATE`,
            () =>
              pair.map((action) =>
                app.request("POST", `${deliveryPath(sent.id)}/${action}`, {}, action === "cancel" ? manager : owner)
              )
          )
          expect(outcomes.map((response) => response.status).sort((a, b) => a - b)).toEqual([200, 409])
          expect(
            await Effect.runPromise(
              app.sql`SELECT count(*)::int AS count FROM stock_movements WHERE delivery_id=${sent.id} AND phase='Terminal'`
            )
          ).toEqual([{ count: 1 }])
        }
        const pending = await send(app, manager, project.id, [{ materialId: material.id, quantity: "1" }])
        const receipts = await race(
          app.sql,
          app.sql`SELECT id FROM projects WHERE public_id=${project.id} FOR UPDATE`,
          () =>
            [1, 2].map(() =>
              app.request("POST", `${deliveryPath(pending.id)}/record`, {}, owner, headers("same-receipt"))
            )
        )
        expect(receipts.map((response) => response.status)).toEqual([200, 200])
        expect(await receipts[0]?.json()).toEqual(await receipts[1]?.json())
        await conserved(app)
      })
    )
  })
  it("coordinates material edits/deletion and project deletion with stock operations", async () => {
    await Effect.runPromise(
      withApp(async (app) => {
        const manager = await app.register("manager@example.test", "CompanyStoreManager")
        const doomed = await makeMaterial(app, manager, "Delete race")
        const deletion = await race(app.sql, app.sql`SELECT id FROM materials WHERE id=${doomed.id} FOR UPDATE`, () => [
          app.request("DELETE", `${materials}/${doomed.id}`, undefined, manager),
          app.request("POST", `${company}/stock/additions`, { materialId: doomed.id, quantity: "1" }, manager)
        ])
        expect(deletion.map((response) => response.status)).toEqual(
          deletion[0]?.status === 204 ? [204, 404] : [409, 201]
        )
        const unit = await makeMaterial(app, manager, "Unit race")
        const editing = await race(app.sql, app.sql`SELECT id FROM materials WHERE id=${unit.id} FOR UPDATE`, () => [
          app.request("PATCH", `${materials}/${unit.id}`, { unit: "bag" }, manager),
          app.request("POST", `${company}/stock/additions`, { materialId: unit.id, quantity: "2" }, manager)
        ])
        expect(editing[1]?.status).toBe(201)
        expect([200, 409]).toContain(editing[0]?.status)
        const current = Schema.decodeUnknownSync(M.Material)(
          await (await app.request("GET", `${materials}/${unit.id}`, undefined, manager)).json()
        )
        expect(current.unit).toBe(editing[0]?.status === 200 ? "bag" : "kg")
        const project = await makeProject(app, manager)
        const projectRace = await race(
          app.sql,
          app.sql`SELECT id FROM projects WHERE public_id=${project.id} FOR UPDATE`,
          () => [
            app.request("DELETE", projectPath(project.id), undefined, manager),
            app.request(
              "POST",
              `${company}/deliveries`,
              { projectId: project.id, lines: [{ materialId: unit.id, quantity: "1" }] },
              manager
            )
          ]
        )
        expect(projectRace.map((response) => response.status)).toEqual(
          projectRace[0]?.status === 204 ? [204, 404] : [409, 201]
        )
        expect(
          await Effect.runPromise(
            app.sql`SELECT count(*)::int AS count FROM stock_balances b JOIN materials m ON m.id=b.material_id WHERE m.deleted_at IS NOT NULL AND b.quantity>0`
          )
        ).toEqual([{ count: 0 }])
        await conserved(app)
      })
    )
  })
  it("rechecks changed roles after waits and revokes access to saved idempotent outcomes", async () => {
    await Effect.runPromise(
      withApp(async (app) => {
        const owner = await app.register("owner@example.test"),
          manager = await app.register("manager@example.test", "CompanyStoreManager")
        const material = await makeMaterial(app, owner),
          project = await makeProject(app, owner)
        await add(app, manager, material.id, "2", "saved-add")
        const delivery = await send(app, manager, project.id, [{ materialId: material.id, quantity: "1" }])
        await act(app, owner, delivery.id, "record")
        await send(app, owner, project.id, [{ materialId: material.id, quantity: "1" }], "saved-return", true)
        const outcomes = await race(
          app.sql,
          Effect.gen(function* () {
            yield* app.sql`SELECT id FROM materials WHERE id=${material.id} FOR UPDATE`
            yield* app.sql`UPDATE users SET role='User' WHERE id=${manager.body.user.id}`
          }),
          () =>
            [1, 2].map(() =>
              app.request("POST", `${company}/stock/additions`, { materialId: material.id, quantity: "1" }, manager)
            )
        )
        expect(outcomes.map((response) => response.status)).toEqual([403, 403])
        expect(
          (
            await app.request(
              "POST",
              `${company}/stock/additions`,
              { materialId: material.id, quantity: "2" },
              manager,
              headers("saved-add")
            )
          ).status
        ).toBe(403)
        await Effect.runPromise(app.sql`UPDATE users SET role='CompanyStoreManager' WHERE id=${manager.body.user.id}`)
        // Fixtures may alter memberships to model revocation; normal member commands use the project lock.
        await Effect.runPromise(app.sql`DELETE FROM memberships WHERE user_id=${owner.body.user.id}`)
        expect(
          (
            await app.request(
              "POST",
              `${projectPath(project.id)}/deliveries`,
              { lines: [{ materialId: material.id, quantity: "1" }] },
              owner,
              headers("saved-return")
            )
          ).status
        ).toBe(404)
        expect((await app.request("GET", `${projectPath(project.id)}/store`, undefined, owner)).status).toBe(404)
        await conserved(app)
      })
    )
  })
  it("moves exact stock both ways, preserves snapshots and gates deletion", async () => {
    await Effect.runPromise(
      withApp(async (app) => {
        const owner = await app.register("owner@example.test"),
          manager = await app.register("manager@example.test", "CompanyStoreManager")
        const material = await makeMaterial(app, owner, "  Cement  ", "  Masonry  ", " kg "),
          project = await makeProject(app, owner)
        expect(material).toMatchObject({ name: "Cement", category: "Masonry", unit: "kg" })
        expect((await companyRows(app, manager)).items[0]).toMatchObject({
          quantity: "0",
          inTransitQuantity: "0",
          reorderPoint: "0",
          status: "OutOfStock"
        })
        await add(app, manager, material.id, "0.1")
        await add(app, manager, material.id, "0.2")
        expect(
          (await app.request("PUT", `${company}/stock/${material.id}/reorder-point`, { reorderPoint: "0.1" }, manager))
            .status
        ).toBe(200)
        const outgoing = await send(app, manager, project.id, [{ materialId: material.id, quantity: "0.2" }])
        expect(outgoing.allowedActions).toEqual(["cancel"])
        expect((await companyRows(app, manager)).items[0]).toMatchObject({
          quantity: "0.1",
          inTransitQuantity: "0.2",
          status: "LowStock"
        })
        expect((await projectRows(app, owner, project.id)).pagination.total).toBe(0)
        await conserved(app)
        const received = await act(app, owner, outgoing.id, "record")
        expect(received).toMatchObject({
          status: "Delivered",
          receivedBy: { id: owner.body.user.id },
          allowedActions: []
        })
        expect(received.receivedAt).not.toBeNull()
        expect((await projectRows(app, owner, project.id)).items[0]).toMatchObject({ quantity: "0.2" })
        expect((await projectRows(app, owner, project.id)).items[0]?.lastDeliveryAt).not.toBeNull()
        expect(
          (await app.request("PATCH", `${materials}/${material.id}`, { name: "Renamed", category: "Concrete" }, owner))
            .status
        ).toBe(200)
        const snapshot = Schema.decodeUnknownSync(M.Delivery)(
          await (await app.request("GET", deliveryPath(outgoing.id), undefined, owner)).json()
        )
        expect(snapshot.lines[0]?.material).toMatchObject({ name: "Cement", unit: "kg" })
        const returning = await send(
          app,
          owner,
          project.id,
          [{ materialId: material.id, quantity: "0.1" }],
          undefined,
          true
        )
        expect((await companyRows(app, manager)).items[0]?.inTransitQuantity).toBe("0")
        await act(app, manager, returning.id, "record")
        const cancelled = await send(app, manager, project.id, [{ materialId: material.id, quantity: "0.05" }])
        expect((await act(app, manager, cancelled.id, "cancel")).receivedAt).toBeNull()
        const rejected = await send(app, manager, project.id, [{ materialId: material.id, quantity: "0.05" }])
        expect((await act(app, owner, rejected.id, "reject")).status).toBe("Rejected")
        expect((await companyRows(app, manager)).items[0]?.quantity).toBe("0.2")
        expect((await app.request("DELETE", projectPath(project.id), undefined, owner)).status).toBe(409)
        expect((await app.request("DELETE", `${materials}/${material.id}`, undefined, owner)).status).toBe(409)
        expect((await app.request("PATCH", `${materials}/${material.id}`, { unit: "bag" }, owner)).status).toBe(409)
        const last = await send(app, owner, project.id, [{ materialId: material.id, quantity: "0.1" }], undefined, true)
        await act(app, manager, last.id, "record")
        expect((await projectRows(app, owner, project.id)).items[0]?.quantity).toBe("0")
        expect((await app.request("DELETE", projectPath(project.id), undefined, owner)).status).toBe(204)
        expect((await app.request("GET", deliveryPath(outgoing.id), undefined, manager)).status).toBe(200)
        expect((await app.request("GET", deliveryPath(outgoing.id), undefined, owner)).status).toBe(404)
        const unused = await makeMaterial(app, owner, "Unused")
        expect((await app.request("PATCH", `${materials}/${unused.id}`, { unit: "bag" }, manager)).status).toBe(200)
        expect((await app.request("DELETE", `${materials}/${unused.id}`, undefined, owner)).status).toBe(204)
        expect((await app.request("DELETE", `${materials}/${unused.id}`, undefined, owner)).status).toBe(404)
        await conserved(app)
      })
    )
  })
  it("rolls back every line on failure and replays normalized successful requests exactly", async () => {
    await Effect.runPromise(
      withApp(async (app) => {
        const owner = await app.register("owner@example.test"),
          manager = await app.register("manager@example.test", "CompanyStoreManager")
        const a = await makeMaterial(app, owner, "A"),
          b = await makeMaterial(app, owner, "B"),
          project = await makeProject(app, owner)
        const addition = await add(app, manager, a.id, "1", "addition")
        expect(await add(app, manager, a.id, "01.000000", "addition")).toEqual(addition)
        const login = await app.request("POST", "/api/v1/auth/login", { email: manager.body.user.email, password })
        expect(login.status).toBe(200)
        const session = Schema.decodeUnknownSync(Core.SessionResult)(await login.json())
        expect(await add(app, { token: session.accessToken }, a.id, "1", "addition")).toEqual(addition)
        await add(app, manager, b.id, "1")
        const failed = await app.request(
          "POST",
          `${company}/deliveries`,
          {
            projectId: project.id,
            lines: [
              { materialId: a.id, quantity: "0.5" },
              { materialId: b.id, quantity: "2" }
            ]
          },
          manager,
          headers("shipment")
        )
        expect(failed.status).toBe(409)
        expect((await companyRows(app, manager)).items.map((item) => item.quantity)).toEqual(["1", "1"])
        expect(await Effect.runPromise(app.sql`SELECT count(*)::int AS count FROM deliveries`)).toEqual([{ count: 0 }])
        const lines = [
          { materialId: a.id, quantity: "0.5" },
          { materialId: b.id, quantity: "0.5" }
        ]
        const sent = await send(app, manager, project.id, lines, "shipment")
        expect(
          await send(
            app,
            manager,
            project.id,
            [...lines].reverse().map((line) => ({ ...line, quantity: "00.500000" })),
            "shipment"
          )
        ).toEqual(sent)
        expect(
          (
            await app.request(
              "POST",
              `${company}/deliveries`,
              { projectId: project.id, lines: [{ materialId: a.id, quantity: "0.1" }] },
              manager,
              headers("shipment")
            )
          ).status
        ).toBe(409)
        const received = await act(app, owner, sent.id, "record", "receipt")
        expect(await act(app, owner, sent.id, "record", "receipt")).toEqual(received)
        expect((await app.request("POST", `${deliveryPath(sent.id)}/record`, {}, owner)).status).toBe(409)
        expect(await Effect.runPromise(app.sql`SELECT count(*)::int AS count FROM stock_movements`)).toEqual([
          { count: 6 }
        ])
        const otherProject = await makeProject(app, owner, "Other target")
        expect(
          (
            await app.request(
              "POST",
              `${company}/deliveries`,
              { projectId: otherProject.id, lines },
              manager,
              headers("shipment")
            )
          ).status
        ).toBe(409)
        const otherDelivery = await send(app, manager, project.id, [{ materialId: a.id, quantity: "0.1" }])
        expect(
          (await app.request("POST", `${deliveryPath(otherDelivery.id)}/record`, {}, owner, headers("receipt"))).status
        ).toBe(409)
        expect(
          Schema.decodeUnknownSync(M.Delivery)(
            await (await app.request("GET", deliveryPath(otherDelivery.id), undefined, owner)).json()
          ).status
        ).toBe("InTransit")
        for (const invalid of ["0", "1e2", "0.0000001", 1, "-1"]) {
          expect(
            (await app.request("POST", `${company}/stock/additions`, { materialId: a.id, quantity: invalid }, manager))
              .status
          ).toBe(400)
        }
        expect(
          (
            await app.request(
              "POST",
              `${company}/stock/additions`,
              { materialId: a.id, quantity: "1" },
              manager,
              headers("bad key")
            )
          ).status
        ).toBe(400)
        expect(
          (
            await app.request(
              "POST",
              `${company}/deliveries`,
              {
                projectId: project.id,
                lines: [
                  { materialId: a.id, quantity: "0.1" },
                  { materialId: a.id.toUpperCase(), quantity: "0.1" }
                ]
              },
              manager
            )
          ).status
        ).toBe(400)
        expect(
          (
            await app.request(
              "POST",
              `${company}/deliveries`,
              {
                projectId: project.id,
                lines: Array.from({ length: 101 }, () => ({ materialId: randomUUID(), quantity: "1" }))
              },
              manager
            )
          ).status
        ).toBe(400)
        await conserved(app)
      })
    )
  })
})
