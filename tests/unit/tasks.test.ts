import { describe, expect, it } from "vitest"
import { makeGraph, isLate, transitionFailure, edgeFailure, deletionFailure } from "../../src/domain/tasks.js"
import type { TaskNode } from "../../src/domain/task-models.js"

const node = (id: string, status: TaskNode["status"] = "NotStarted"): TaskNode => ({
  id,
  internalId: id,
  number: "1",
  name: id,
  startDate: "2026-11-14",
  endDate: "2026-11-20",
  status,
  firstStartedAt: status === "NotStarted" ? null : "2026-11-14T00:00:00.000Z"
})
const edge = (dependent: string, prerequisite: string) => ({ dependent, prerequisite })

describe("task domain laws (DAG-01, TASK-01/02/03)", () => {
  it("deduplicates diamond ancestry and uses shortest positive distance", () => {
    const graph = makeGraph(
      [node("a"), node("b"), node("c"), node("d")],
      [edge("b", "a"), edge("c", "a"), edge("d", "b"), edge("d", "c"), edge("d", "a")]
    )
    expect(new Map(graph.reachable("d", "prerequisites").map((x) => [x.id, x.distance]))).toEqual(
      new Map([
        ["b", 1],
        ["c", 1],
        ["a", 1]
      ])
    )
    expect(graph.reachable("a", "dependents")).toHaveLength(3)
    expect(graph.isBlocked("d")).toBe(true)
    expect(edgeFailure(graph, "a", "d")).toBe("DEPENDENCY_CYCLE")
    expect(edgeFailure(graph, "a", "a")).toBe("SELF_DEPENDENCY")
    expect(edgeFailure(graph, "b", "a")).toBe("DEPENDENCY_EXISTS")
  })
  it.each(["NotStarted", "InProgress", "Done"] as const)("allows only specified actions from %s", (status) => {
    const graph = makeGraph([node("a", status)], [])
    for (const action of ["start", "complete", "reopen"] as const) {
      const legal =
        (status === "NotStarted" && action === "start") ||
        (status === "InProgress" && action === "complete") ||
        (status === "Done" && action === "reopen")
      expect(transitionFailure(graph, "a", action)).toBe(legal ? undefined : "TASK_STATE_CONFLICT")
    }
  })
  it("checks transitive prerequisites even through a Done intermediate", () => {
    const graph = makeGraph([node("a"), node("b", "Done"), node("c")], [edge("c", "b"), edge("b", "a")])
    expect(transitionFailure(graph, "c", "start")).toBe("TASK_BLOCKED")
    expect(graph.isBlocked("b")).toBe(false)
    expect(graph.isBlocked("c")).toBe(true)
  })
  it.each(["InProgress", "Done"] as const)("blocks reopen when a transitive dependent is %s", (status) => {
    const graph = makeGraph([node("a", "Done"), node("b"), node("c", status)], [edge("b", "a"), edge("c", "b")])
    expect(transitionFailure(graph, "a", "reopen")).toBe("TASK_DEPENDENTS_STARTED")
    expect(edgeFailure(graph, "c", "a")).toBe("DEPENDENCY_LOCKED")
    expect(deletionFailure(graph, "a")).toBe("TASK_HAS_DEPENDENTS")
    expect(deletionFailure(graph, "c")).toBeUndefined()
  })
  it("uses strict calendar boundaries, independently of Blocked", () => {
    expect(isLate(node("a"), "2026-11-14")).toBe(false)
    expect(isLate(node("a"), "2026-11-15")).toBe(true)
    expect(isLate(node("a", "InProgress"), "2026-11-20")).toBe(false)
    expect(isLate(node("a", "InProgress"), "2026-11-21")).toBe(true)
    expect(isLate(node("a", "Done"), "2026-11-21")).toBe(false)
    const graph = makeGraph([node("a"), node("b")], [edge("b", "a")])
    expect(isLate(graph.require("b"), "2026-11-21") && graph.isBlocked("b")).toBe(true)
  })
  it("handles 3,000-node chains without recursion or path enumeration", () => {
    const tasks = Array.from({ length: 3000 }, (_, i) => node(String(i)))
    const graph = makeGraph(
      tasks,
      tasks.slice(1).map((_, i) => edge(String(i + 1), String(i)))
    )
    expect(graph.reachable("2999", "prerequisites")).toHaveLength(2999)
    expect(graph.reachable("2999", "prerequisites").at(-1)).toEqual({ id: "0", distance: 2999 })
  })
  it("agrees with an independent all-pairs distance oracle on generated DAGs", () => {
    let seed = 19
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed
    }
    for (let sample = 0; sample < 20; sample++) {
      const size = 12,
        tasks = Array.from({ length: size }, (_, i) => node(String(i)))
      const edges: Array<ReturnType<typeof edge>> = []
      const distances = Array.from({ length: size }, (_, i) =>
        Array.from({ length: size }, (_, j) => (i === j ? 0 : Infinity))
      )
      for (let i = 1; i < size; i++)
        for (let j = 0; j < i; j++)
          if (random() % 3 === 0) {
            edges.push(edge(String(i), String(j)))
            const row = distances[i]
            if (row) row[j] = 1
          }
      for (let k = 0; k < size; k++)
        for (let i = 0; i < size; i++)
          for (let j = 0; j < size; j++) {
            const row = distances[i]
            if (row) row[j] = Math.min(row[j] ?? Infinity, (row[k] ?? Infinity) + (distances[k]?.[j] ?? Infinity))
          }
      const graph = makeGraph(tasks, edges)
      for (let i = 0; i < size; i++) {
        const actual = new Map(graph.reachable(String(i), "prerequisites").map((x) => [x.id, x.distance]))
        for (let j = 0; j < size; j++) if (i !== j) expect(actual.get(String(j)) ?? Infinity).toBe(distances[i]?.[j])
      }
    }
  })
})
