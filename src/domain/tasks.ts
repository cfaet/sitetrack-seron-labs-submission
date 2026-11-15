import type { TaskAction, TaskEdge, TaskNode } from "./task-models.js"

export type TaskRuleFailure =
  | "TASK_STATE_CONFLICT"
  | "TASK_BLOCKED"
  | "TASK_DEPENDENTS_STARTED"
  | "DEPENDENCY_LOCKED"
  | "SELF_DEPENDENCY"
  | "DEPENDENCY_EXISTS"
  | "DEPENDENCY_CYCLE"
  | "TASK_HAS_DEPENDENTS"
export const isLate = (task: TaskNode, today: string) =>
  task.status !== "Done" && (task.endDate < today || (task.status === "NotStarted" && task.startDate < today))

export const makeGraph = (tasks: ReadonlyArray<TaskNode>, edges: ReadonlyArray<TaskEdge>) => {
  const nodes = new Map(tasks.map((task) => [task.id, task]))
  const prerequisites = new Map<string, Array<string>>()
  const dependents = new Map<string, Array<string>>()
  const require = (id: string) => {
    const task = nodes.get(id)
    if (!task) throw new Error("Graph snapshot references a missing task")
    return task
  }
  for (const task of tasks) {
    prerequisites.set(task.id, [])
    dependents.set(task.id, [])
  }
  for (const edge of edges) {
    require(edge.dependent)
    require(edge.prerequisite)
    prerequisites.get(edge.dependent)?.push(edge.prerequisite)
    dependents.get(edge.prerequisite)?.push(edge.dependent)
  }
  const direct = (id: string, direction: "prerequisites" | "dependents") => {
    require(id)
    return (direction === "prerequisites" ? prerequisites : dependents).get(id) ?? []
  }
  const reachable = (id: string, direction: "prerequisites" | "dependents") => {
    const visited = new Set([id]),
      queue: Array<{ id: string; distance: number }> = []
    for (const next of direct(id, direction)) {
      if (!visited.has(next)) {
        visited.add(next)
        queue.push({ id: next, distance: 1 })
      }
    }
    for (let i = 0; i < queue.length; i++) {
      const entry = queue[i]
      if (!entry) continue
      for (const next of direct(entry.id, direction))
        if (!visited.has(next)) {
          visited.add(next)
          queue.push({ id: next, distance: entry.distance + 1 })
        }
    }
    return queue
  }
  // Multi-source reverse propagation visits each node/edge once, including Done intermediates.
  const blocked = new Set<string>(),
    queue: Array<string> = []
  for (const edge of edges)
    if (require(edge.prerequisite).status !== "Done" && !blocked.has(edge.dependent)) {
      blocked.add(edge.dependent)
      queue.push(edge.dependent)
    }
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]
    if (id === undefined) continue
    for (const next of direct(id, "dependents"))
      if (!blocked.has(next)) {
        blocked.add(next)
        queue.push(next)
      }
  }
  return {
    tasks,
    require,
    get: (id: string) => nodes.get(id),
    direct,
    reachable,
    isBlocked: (id: string) => require(id).status !== "Done" && blocked.has(id)
  }
}
export type TaskGraph = ReturnType<typeof makeGraph>
export const transitionFailure = (graph: TaskGraph, id: string, action: TaskAction): TaskRuleFailure | undefined => {
  const task = graph.require(id)
  if (action === "start" && task.status === "NotStarted") return graph.isBlocked(id) ? "TASK_BLOCKED" : undefined
  if (action === "complete" && task.status === "InProgress") return undefined
  if (action === "reopen" && task.status === "Done")
    return graph.reachable(id, "dependents").some((entry) => graph.require(entry.id).firstStartedAt !== null)
      ? "TASK_DEPENDENTS_STARTED"
      : undefined
  return "TASK_STATE_CONFLICT"
}
export const edgeFailure = (graph: TaskGraph, dependent: string, prerequisite: string): TaskRuleFailure | undefined => {
  if (dependent === prerequisite) return "SELF_DEPENDENCY"
  if (graph.require(dependent).firstStartedAt !== null) return "DEPENDENCY_LOCKED"
  if (graph.direct(dependent, "prerequisites").includes(prerequisite)) return "DEPENDENCY_EXISTS"
  if (graph.reachable(prerequisite, "prerequisites").some((task) => task.id === dependent)) return "DEPENDENCY_CYCLE"
  return undefined
}
export const deletionFailure = (graph: TaskGraph, id: string): TaskRuleFailure | undefined =>
  graph.direct(id, "dependents").length > 0 ? "TASK_HAS_DEPENDENTS" : undefined
