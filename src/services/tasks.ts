import { randomUUID } from "node:crypto"
import { Context, Effect, Layer, Schema } from "effect"
import { CompanyTime } from "../config/company.js"
import { conflict, invalid, notFound } from "../domain/errors.js"
import type { Actor, ListQuery } from "../domain/models.js"
import {
  publicTaskId,
  type Task,
  type TaskAction,
  type TaskInput,
  type TaskPatch,
  type TaskQuery
} from "../domain/task-models.js"
import {
  deletionFailure,
  edgeFailure,
  isLate,
  transitionFailure,
  type TaskGraph,
  type TaskRuleFailure
} from "../domain/tasks.js"
import { Database, execute, page, paginated, rows } from "../repositories/database.js"
import { loadTaskGraph } from "../repositories/tasks.js"
import { projectTransaction } from "./access.js"
import { Auth } from "./auth.js"

const messages: Readonly<Record<TaskRuleFailure, string>> = {
  TASK_STATE_CONFLICT: "This action is not allowed in the task's current state.",
  TASK_BLOCKED: "All prerequisites must be Done before starting.",
  TASK_DEPENDENTS_STARTED: "A reachable dependent has already started.",
  DEPENDENCY_LOCKED: "Dependencies cannot change after the dependent starts.",
  SELF_DEPENDENCY: "A task cannot depend on itself.",
  DEPENDENCY_EXISTS: "The dependency already exists.",
  DEPENDENCY_CYCLE: "The dependency would create a cycle.",
  TASK_HAS_DEPENDENTS: "Remove active incoming dependencies before deleting this task."
}
const enforce = (failure: TaskRuleFailure | undefined) =>
  failure === undefined ? Effect.void : Effect.fail(conflict(failure, messages[failure]))
const compare = (left: string | number | bigint, right: string | number | bigint) =>
  left < right ? -1 : left > right ? 1 : 0
const taskProjection = (graph: TaskGraph, id: string, projectId: string, today: string): Task => {
  const task = graph.require(id)
  return {
    id: task.id,
    projectId,
    name: task.name,
    startDate: task.startDate,
    endDate: task.endDate,
    status: task.status,
    firstStartedAt: task.firstStartedAt,
    late: isLate(task, today),
    blocked: graph.isBlocked(id),
    directDependentCount: graph.direct(id, "dependents").length,
    directPrerequisites: graph.direct(id, "prerequisites").map((id) => {
      const p = graph.require(id)
      return { id: p.id, name: p.name, status: p.status }
    })
  }
}
const detailProjection = (graph: TaskGraph, id: string, projectId: string, today: string) => ({
  ...taskProjection(graph, id, projectId, today),
  allowedActions: (["start", "complete", "reopen"] as const).filter(
    (action) => transitionFailure(graph, id, action) === undefined
  )
})
const makeTasks = Effect.gen(function* () {
  const sql = yield* Database,
    clock = yield* CompanyTime,
    auth = yield* Auth
  const bind = <A, E>(effect: Effect.Effect<A, E, Database | Auth>) =>
    effect.pipe(Effect.provideService(Database, sql), Effect.provideService(Auth, auth))
  const requireTask = (graph: TaskGraph, id: string) => {
    const task = graph.get(id)
    return task === undefined ? Effect.fail(notFound()) : Effect.succeed(task)
  }
  const get = Effect.fn("Tasks.get")(
    function* (actor: Actor, projectId: string, id: string) {
      const now = yield* clock.now,
        graph = yield* loadTaskGraph(actor, projectId)
      yield* requireTask(graph, id)
      return detailProjection(graph, id, projectId, now.today)
    },
    execute,
    bind
  )
  const list = Effect.fn("Tasks.list")(
    function* (actor: Actor, projectId: string, query: TaskQuery) {
      const now = yield* clock.now,
        graph = yield* loadTaskGraph(actor, projectId),
        pagination = page(query)
      const search = (query.search ?? "").toLowerCase()
      const selected = graph.tasks.filter(
        (task) =>
          (!query.status || task.status === query.status) &&
          (query.late === undefined || isLate(task, now.today) === (query.late === "true")) &&
          (query.blocked === undefined || graph.isBlocked(task.id) === (query.blocked === "true")) &&
          (query.fromDate === undefined || task.endDate >= query.fromDate) &&
          (query.toDate === undefined || task.startDate <= query.toDate) &&
          (task.id.toLowerCase().includes(search) || task.name.toLowerCase().includes(search))
      )
      const value = (task: (typeof graph.tasks)[number]) =>
        query.sort === "name"
          ? task.name.toLowerCase()
          : query.sort === "startDate"
            ? task.startDate
            : query.sort === "endDate"
              ? task.endDate
              : query.sort === "dependentCount"
                ? graph.direct(task.id, "dependents").length
                : BigInt(task.number)
      selected.sort(
        (a, b) =>
          (query.direction === "desc" ? -1 : 1) * compare(value(a), value(b)) || compare(a.internalId, b.internalId)
      )
      return paginated(
        selected
          .slice(pagination.offset, pagination.offset + pagination.pageSize)
          .map((task) => taskProjection(graph, task.id, projectId, now.today)),
        selected.length,
        pagination
      )
    },
    execute,
    bind
  )
  const relations = Effect.fn("Tasks.relations")(
    function* (
      actor: Actor,
      projectId: string,
      id: string,
      direction: "prerequisites" | "dependents",
      query: ListQuery
    ) {
      const now = yield* clock.now,
        graph = yield* loadTaskGraph(actor, projectId),
        pagination = page(query)
      yield* requireTask(graph, id)
      const found = graph
        .reachable(id, direction)
        .sort(
          (a, b) =>
            a.distance - b.distance || compare(BigInt(graph.require(a.id).number), BigInt(graph.require(b.id).number))
        )
      return paginated(
        found
          .slice(pagination.offset, pagination.offset + pagination.pageSize)
          .map((entry) => ({ ...taskProjection(graph, entry.id, projectId, now.today), distance: entry.distance })),
        found.length,
        pagination
      )
    },
    execute,
    bind
  )
  const create = Effect.fn("Tasks.create")(
    (actor: Actor, projectId: string, input: typeof TaskInput.Type) =>
      projectTransaction(actor, projectId, false, (project, current) =>
        Effect.gen(function* () {
          const inserted = yield* rows(
            Schema.Struct({ number: Schema.String }),
            sql`UPDATE projects SET task_counter=task_counter+1 WHERE id=${project.internalId} RETURNING task_counter::text AS number`
          )
          const number = inserted[0]?.number
          if (number === undefined) return yield* Effect.die(new Error("Task counter update returned no row"))
          const id = publicTaskId(projectId, number)
          yield* sql`INSERT INTO tasks(id,project_id,task_number,public_id,name,start_date,end_date) VALUES (${randomUUID()},${project.internalId},${number},${id},${input.name},${input.startDate},${input.endDate})`
          return yield* get(current, projectId, id)
        })
      ),
    execute,
    bind
  )
  const update = Effect.fn("Tasks.update")(
    (actor: Actor, projectId: string, id: string, input: typeof TaskPatch.Type) =>
      projectTransaction(actor, projectId, false, (_, current) =>
        Effect.gen(function* () {
          const graph = yield* loadTaskGraph(current, projectId),
            task = yield* requireTask(graph, id)
          const name = input.name ?? task.name,
            start = input.startDate ?? task.startDate,
            end = input.endDate ?? task.endDate
          if (start > end) return yield* invalid()
          yield* sql`UPDATE tasks SET name=${name},start_date=${start},end_date=${end} WHERE id=${task.internalId}`
          return yield* get(current, projectId, id)
        })
      ),
    execute,
    bind
  )
  const action = Effect.fn("Tasks.action")(
    (actor: Actor, projectId: string, id: string, action: TaskAction) =>
      projectTransaction(actor, projectId, false, (_, current) =>
        Effect.gen(function* () {
          const now = yield* clock.now,
            graph = yield* loadTaskGraph(current, projectId),
            task = yield* requireTask(graph, id)
          yield* enforce(transitionFailure(graph, id, action))
          const status = action === "complete" ? "Done" : "InProgress"
          yield* sql`UPDATE tasks SET status=${status},first_started_at=coalesce(first_started_at,${now.instant}::timestamptz) WHERE id=${task.internalId}`
          return detailProjection(yield* loadTaskGraph(current, projectId), id, projectId, now.today)
        })
      ),
    execute,
    bind
  )
  const remove = Effect.fn("Tasks.remove")(
    (actor: Actor, projectId: string, id: string) =>
      projectTransaction(actor, projectId, false, (project, current) =>
        Effect.gen(function* () {
          const now = yield* clock.now,
            graph = yield* loadTaskGraph(current, projectId),
            task = yield* requireTask(graph, id)
          yield* enforce(deletionFailure(graph, id))
          yield* sql`DELETE FROM task_dependencies WHERE project_id=${project.internalId} AND dependent_id=${task.internalId}`
          yield* sql`UPDATE tasks SET deleted_at=${now.instant} WHERE id=${task.internalId}`
        })
      ),
    execute,
    bind
  )
  const addDependency = Effect.fn("Tasks.addDependency")(
    (actor: Actor, projectId: string, id: string, prerequisiteId: string) =>
      projectTransaction(actor, projectId, false, (project, current) =>
        Effect.gen(function* () {
          const graph = yield* loadTaskGraph(current, projectId),
            task = yield* requireTask(graph, id),
            prerequisite = yield* requireTask(graph, prerequisiteId)
          yield* enforce(edgeFailure(graph, id, prerequisiteId))
          yield* sql`INSERT INTO task_dependencies(project_id,dependent_id,prerequisite_id) VALUES (${project.internalId},${task.internalId},${prerequisite.internalId})`
          return { dependentTaskId: id, prerequisiteTaskId: prerequisiteId }
        })
      ),
    execute,
    bind
  )
  const removeDependency = Effect.fn("Tasks.removeDependency")(
    (actor: Actor, projectId: string, id: string, prerequisiteId: string) =>
      projectTransaction(actor, projectId, false, (project, current) =>
        Effect.gen(function* () {
          const graph = yield* loadTaskGraph(current, projectId),
            task = yield* requireTask(graph, id),
            prerequisite = yield* requireTask(graph, prerequisiteId)
          if (!graph.direct(id, "prerequisites").includes(prerequisiteId)) return yield* notFound()
          if (task.firstStartedAt !== null) return yield* enforce("DEPENDENCY_LOCKED")
          yield* sql`DELETE FROM task_dependencies WHERE project_id=${project.internalId} AND dependent_id=${task.internalId} AND prerequisite_id=${prerequisite.internalId}`
        })
      ),
    execute,
    bind
  )
  return { get, list, relations, create, update, action, remove, addDependency, removeDependency }
})
export class Tasks extends Context.Service<Tasks, Effect.Success<typeof makeTasks>>()("sitetrack/Tasks") {
  static readonly layer = Layer.effect(Tasks, makeTasks)
}
