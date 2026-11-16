import { Schema } from "effect"

export const Profile = Schema.Literals(["small", "large"])
export type Profile = typeof Profile.Type
export const IntegrityPlanMode = Schema.Literals(["estimate", "analyze"])
export const generatorVersion = 2
export const referenceDate = "2026-11-01"
export const randomSeed = 42
// Public demo password, only for explicitly generated local datasets.
export const demoPassword = "SiteTrack local demo password 42!"
export const profiles = {
  small: {
    users: 100,
    projects: 20,
    invitations: 500,
    tasks: 2000,
    edges: 4000,
    materials: 200,
    deliveries: 1000,
    lines: 7500
  },
  large: {
    users: 5000,
    projects: 2000,
    invitations: 50000,
    tasks: 500000,
    edges: 1000000,
    materials: 20000,
    deliveries: 400000,
    lines: 3000000
  }
} satisfies Record<Profile, Record<string, number>>
export const uid = (kind: number, index: number) =>
  `${kind.toString(16)}0000000-0000-4000-8000-${String(index).padStart(12, "0")}`
export const projectPlan = (profile: Profile) => {
  const counts = profiles[profile]
  const hot = profile === "large" ? 4 : 1,
    maximum = profile === "large" ? 3000 : 300
  const remaining = counts.tasks - hot * maximum
  let offset = 0,
    distributed = 0
  return Array.from({ length: counts.projects }, (_, i) => {
    const n =
      i < hot
        ? maximum
        : Math.floor(remaining / (counts.projects - hot)) + (i - hot < remaining % (counts.projects - hot) ? 1 : 0)
    const edgeCount =
      i === 0
        ? n - 1
        : Math.floor(((counts.edges - (maximum - 1)) * (offset + n - maximum)) / (counts.tasks - maximum)) - distributed
    if (i > 0) distributed += edgeCount
    const result = { number: i + 1, tasks: n, offset, edges: edgeCount, members: i % 4 === 0 ? 50 : 5 + (i % 40) }
    offset += n
    return result
  })
}
export const percentile = (values: ReadonlyArray<number>, fraction: number) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null
}
