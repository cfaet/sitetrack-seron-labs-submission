import { describe, expect, it } from "vitest"
import { percentile, profiles, projectPlan, uid } from "../../src/scale/profile.js"
import { benchmarkCases, benchmarkProtocol } from "../../src/scale/benchmark.js"
describe("repeatable scale inputs", () => {
  it("keeps full and smoke protocols stable and bounds focused ten-client measurement", () => {
    expect(benchmarkProtocol("bench")).toEqual({ clients: 10, samples: 200, repetitions: 3, warmup: 20 })
    expect(benchmarkProtocol("smoke")).toEqual({ clients: 2, samples: 20, repetitions: 1, warmup: 2 })
    expect(benchmarkProtocol("focus")).toEqual({ clients: 10, samples: 50, repetitions: 1, warmup: 20 })
    expect(benchmarkCases("large")).toHaveLength(28)
    expect(benchmarkCases("large", "focus").map((test) => test.name)).toEqual([
      "profile",
      "projects-member",
      "projects-company",
      "projects-completion",
      "projects-late",
      "projects-search-deep",
      "project-detail",
      "tasks",
      "prerequisites",
      "materials",
      "company-deliveries",
      "company-deliveries-filter",
      "company-deliveries-deep"
    ])
  })
  it.each(["small", "large"] as const)("reaches exact %s counts with bounded project sizes", (profile) => {
    const plan = projectPlan(profile),
      c = profiles[profile]
    expect(plan).toEqual(projectPlan(profile))
    expect(plan.reduce((s, p) => s + p.tasks, 0)).toBe(c.tasks)
    expect(plan.reduce((s, p) => s + p.edges, 0)).toBe(c.edges)
    expect(plan.every((p) => p.tasks <= 3000 && p.members <= 50 && p.members > 0 && p.edges < 5 * p.tasks - 15)).toBe(
      true
    )
    expect(plan[0]?.offset).toBe(0)
    expect(new Set(plan.map((p) => uid(2, p.number))).size).toBe(c.projects)
  })
  it("uses nearest-rank percentiles, including empty input", () => {
    expect(percentile([], 0.95)).toBeNull()
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3)
    expect(
      percentile(
        Array.from({ length: 100 }, (_, i) => i + 1),
        0.95
      )
    ).toBe(95)
  })
})
