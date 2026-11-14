import { spawnSync } from "node:child_process"
import { expect, it } from "vitest"

it("rejects invalid startup configuration with a nonzero exit and sanitized structured logs", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/main.ts"], {
    env: {
      PATH: process.env.PATH,
      DATABASE_URL: "postgresql://sitetrack:do_not_log_this@127.0.0.1/sitetrack",
      PORT: "invalid"
    },
    encoding: "utf8",
    timeout: 15000
  })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(1)
  expect(result.stdout).toContain('"startup_failed"')
  expect(result.stdout + result.stderr).not.toMatch(/do_not_log_this|postgresql:\/\/|SELECT|SchemaError/)
  for (const line of result.stdout.trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow()
}, 20000)
