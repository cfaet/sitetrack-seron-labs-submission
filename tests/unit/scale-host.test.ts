import { spawn } from "node:child_process"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// Simulate only the external Docker/Git boundary; execute the actual host wrapper.
const commandFixture = `
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (process.argv[1].endsWith("git")) {
  if (args[0] === "rev-parse") console.log("test-revision");
} else {
  appendFileSync("commands.jsonl", JSON.stringify(args) + "\\n");
  if (args.includes("inspect")) console.log("/scale-test sha256:test 1000000000 1073741824");
  else if (args.includes("ps")) {
    if (args.includes("--quiet")) console.log("api-id\\ndb-id");
    else {
      console.log(JSON.stringify({Name: "scale-test-api", Service: "api", ID: "aaaaaaaaaaaa", State: "running"}));
      console.log(JSON.stringify({Name: "scale-test-db", Service: "db", ID: "bbbbbbbbbbbb", State: "running"}));
    }
  } else if (args.includes("run")) {
    if (process.env.SITETRACK_REPORTING_TEST_MODE === "report") {
      const phase = {attempts: 1, successes: 1};
      console.log(JSON.stringify({result: {passed: false, verdict: "request_errors", expectedCases: 1, protocol: {samples: 1}, mixed: [],
        results: [{complete: true, targetMet: false, phaseResults: {firstAccess: phase, measured: phase,
          warmup: {attempts: 1, successes: 0}}}]}}));
    }
    process.exitCode = 1;
  } else if (args.includes("logs")) {
    const timestamp = "2026-11-16T06:55:00.000Z";
    const requestId = "b102e7b1-38f0-4d68-ae9e-90d538b053f7";
    if (args.at(-1) === "aaaaaaaaaaaa") console.log(timestamp + " " + JSON.stringify({timestamp,
      message: {event: "database_failure", category: "connection_acquisition", reason: "ConnectionError", cause: "PRIVATE_SENTINEL"},
      annotations: {requestId, token: "PRIVATE_SENTINEL"}}));
    else console.error(timestamp + " 2026-11-16 06:55:00.000 UTC [123] ERROR:  canceling statement due to statement timeout\\n" +
      timestamp + " 2026-11-16 06:55:00.000 UTC [123] STATEMENT: SELECT 'PRIVATE_SENTINEL'");
  }
}
`

describe("scale host failure evidence", () => {
  it.each(["report", "crash"])(
    "preserves sanitized diagnostics after tool %s",
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), "sitetrack-scale-host-"))
      try {
        const bin = join(directory, "bin")
        await mkdir(bin)
        await writeFile(join(directory, "package.json"), '{"type":"module"}')
        for (const name of ["docker", "git"])
          await writeFile(join(bin, name), `#!${process.execPath}\n${commandFixture}`, { mode: 0o700 })
        const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              "--import",
              new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href,
              fileURLToPath(new URL("../../src/scale/host.ts", import.meta.url)),
              "focus",
              "large"
            ],
            {
              cwd: directory,
              env: {
                ...process.env,
                PATH: `${bin}:${process.env.PATH ?? ""}`,
                DOCKER_HOST: "unix:///scale-test.sock",
                DOCKER_CONTEXT: "",
                SITETRACK_SCALE_RUN: "test",
                SITETRACK_REPORTING_TEST_MODE: mode
              },
              stdio: ["ignore", "pipe", "pipe"]
            }
          )
          let stdout = "",
            stderr = ""
          child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString()
          })
          child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString()
          })
          child.on("error", reject)
          child.on("close", (code) => resolve({ code, stdout, stderr }))
        })
        expect(result.code).toBe(1)
        expect(result.stdout + result.stderr).not.toContain("PRIVATE_SENTINEL")
        const reports = join(directory, ".scale-results/sitetrack-scale-large-test")
        const names = await readdir(reports)
        expect(names.some((name) => name.endsWith("-api.jsonl"))).toBe(true)
        expect(names.some((name) => name.endsWith("-postgres.jsonl"))).toBe(true)
        expect(names.some((name) => name.endsWith("-diagnostics.json"))).toBe(true)
        const files = await Promise.all(names.map((name) => readFile(join(reports, name), "utf8")))
        expect(files.join("\n")).not.toContain("PRIVATE_SENTINEL")
        expect(files.join("\n")).toContain("statement_timeout")
        expect(files.join("\n")).toContain("connection_acquisition")
        if (mode === "report") {
          expect(result.stdout).toContain("Warmup: 1/1 errors")
          expect(result.stdout).toContain("Measured: 1/1 successful; 0/1 errors")
          expect(names).toContain("latest.json")
        } else expect(names).not.toContain("latest.json")
        const commands = await readFile(join(directory, "commands.jsonl"), "utf8")
        expect(commands).toContain('"--since"')
        expect(commands).toContain('"--until"')
        expect(commands).not.toMatch(/"(?:up|down|seed)"/)
        expect(names).not.toContain("operation.lock")
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
    20000
  )
})
