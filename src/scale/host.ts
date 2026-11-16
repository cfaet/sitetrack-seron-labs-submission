import { createWriteStream } from "node:fs"
import { spawn } from "node:child_process"
import { mkdir, open, readFile, statfs, unlink, writeFile } from "node:fs/promises"
import { hostname, cpus, totalmem, platform, release } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import { Profile, IntegrityPlanMode } from "./profile.js"
import { collectScaleDiagnostics, pressureSnapshot } from "./diagnostics.js"
import { summarizeBenchmark } from "./measurement.js"
import { captureCommand, CaptureError } from "./capture.js"

const command = process.argv[2] ?? "status",
  profile = Schema.decodeUnknownSync(Profile)(process.argv[3] ?? "small")
const planMode = Schema.decodeUnknownSync(IntegrityPlanMode)(process.argv[4] ?? "estimate")
const name = process.env.SITETRACK_SCALE_RUN ?? "local"
if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(name)) throw new Error("Invalid SITETRACK_SCALE_RUN.")
const project = `sitetrack-scale-${profile}-${name}`
const directory = join(".scale-results", project)
const env: NodeJS.ProcessEnv = { ...process.env, SITETRACK_HTTP_PORT: profile === "small" ? "3001" : "3002" }
let selectedDockerHost: string | undefined
const run = (cmd: string, args: ReadonlyArray<string>, capture = false) =>
  new Promise<string>((resolve, reject) => {
    const effectiveArgs = cmd === "docker" && selectedDockerHost ? ["--host", selectedDockerHost, ...args] : [...args]
    const preserveProgress = capture && cmd === "docker" && args.includes("run")
    const evidence = preserveProgress
      ? createWriteStream(join(directory, `progress-${process.pid}.log`), { flags: "a" })
      : undefined
    const child = spawn(cmd, effectiveArgs, {
      env,
      stdio: ["ignore", capture ? "pipe" : "inherit", preserveProgress ? "pipe" : "inherit"]
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk)
      evidence?.write(chunk)
    })
    let result = ""
    child.stdout?.on("data", (chunk: Buffer) => {
      result += chunk.toString()
    })
    let interrupted = false
    const forward = () => {
      interrupted = true
      const nameIndex = args.indexOf("--name")
      const container = nameIndex >= 0 ? args[nameIndex + 1] : undefined
      if (cmd === "docker" && container && selectedDockerHost) {
        const stopper = spawn("docker", ["--host", selectedDockerHost, "stop", "--time", "10", container], {
          env,
          stdio: "ignore"
        })
        stopper.once("close", () => child.kill("SIGTERM"))
        stopper.once("error", () => child.kill("SIGTERM"))
      } else child.kill("SIGTERM")
    }
    process.once("SIGINT", forward)
    process.once("SIGTERM", forward)
    child.on("error", (error) => {
      evidence?.end()
      reject(error)
    })
    child.on("close", (code) => {
      evidence?.end()
      process.removeListener("SIGINT", forward)
      process.removeListener("SIGTERM", forward)
      if (!interrupted && (code === 0 || (capture && result.trim().startsWith("{")))) resolve(result)
      else reject(new Error(`${cmd} exited ${code}; partial reports may be available.`))
    })
  })
const compose = (args: ReadonlyArray<string>, capture = false) =>
  run(
    "docker",
    [
      "compose",
      "--env-file",
      "/dev/null",
      "--project-name",
      project,
      "-f",
      "compose.yaml",
      "-f",
      "compose.benchmark.yaml",
      ...args
    ],
    capture
  )
const tool = (action: string) =>
  compose(
    [
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "--name",
      `${project}-tool-${process.pid}`,
      "tools",
      action,
      profile,
      ...(action === "integrity-plan" ? [planMode] : [])
    ],
    true
  )
const main = async () => {
  await mkdir(directory, { recursive: true })
  if (command === "report") {
    console.log(await readFile(join(directory, "latest.md"), "utf8"))
    return
  }
  const context = process.env.DOCKER_CONTEXT
  const target = context
    ? (await run("docker", ["context", "inspect", context, "--format", "{{.Endpoints.docker.Host}}"], true)).trim()
    : (process.env.DOCKER_HOST ??
      (await run("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], true)).trim())
  if (!target.startsWith("unix://")) throw new Error("Scale orchestration requires a local Unix-socket Docker target.")
  selectedDockerHost = target
  delete env.DOCKER_CONTEXT
  delete env.DOCKER_HOST
  const lock = join(directory, "operation.lock")
  if (command === "status") {
    console.log(JSON.stringify({ project, port: env.SITETRACK_HTTP_PORT, directory }))
    await compose(["ps"])
    console.log(await tool("status"))
    return
  }
  const lease = await open(lock, "wx").catch(() => {
    throw new Error(`Another operation owns ${lock}. If interrupted, inspect its PID before removing a stale lock.`)
  })
  await lease.writeFile(JSON.stringify({ pid: process.pid, command, startedAt: new Date().toISOString() }))
  await lease.close()
  try {
    if (command === "up") {
      await compose(["build", "api", "tools"])
      await compose(["up", "--detach", "--wait", "--wait-timeout", "180"])
      return
    }
    if (command === "down") {
      await compose(["down"])
      return
    }
    if (command === "seed") {
      await compose(["build", "api", "tools"])
      await compose(["up", "--detach", "--wait", "--wait-timeout", "180", "db"])
      await compose(["stop", "api"])
      const output = await tool("seed")
      await writeFile(join(directory, "seed.json"), output)
      console.log(output)
      await compose(["up", "--detach", "--wait", "--wait-timeout", "180", "api"])
      return
    }
    if (command === "check") {
      const output = await tool("check")
      console.log(output)
      await writeFile(join(directory, "check.json"), output)
      return
    }
    if (!["smoke", "focus", "bench", "plans", "integrity-plan"].includes(command))
      throw new Error("Expected up/down/seed/check/smoke/focus/bench/plans/integrity-plan/status/report.")
    const commit = (await run("git", ["rev-parse", "HEAD"], true)).trim()
    const dirty = (await run("git", ["status", "--porcelain"], true)).trim() !== ""
    const containers = await compose(["ps", "--format", "json"], true)
    const decodeContainer = Schema.decodeSync(
      Schema.fromJsonString(
        Schema.Struct({ Service: Schema.String, ID: Schema.String.check(Schema.isPattern(/^[a-f0-9]{12,64}$/)) })
      )
    )
    const containerStates = containers
      .split("\n")
      .filter(Boolean)
      .map((line) => decodeContainer(line))
    const containerIds = (await compose(["ps", "--quiet", "api", "db"], true)).trim().split("\n").filter(Boolean)
    const actualResources = []
    for (const id of containerIds)
      actualResources.push(
        (
          await run(
            "docker",
            ["inspect", "--format", "{{.Name}} {{.Image}} {{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}", id],
            true
          )
        ).trim()
      )
    const disk = await statfs(".")
    const loadBefore = await readFile("/proc/loadavg", "utf8")
    const pressureBefore = await pressureSnapshot()
    const started = new Date().toISOString()
    const prefix = `${command}${command === "integrity-plan" ? `-${planMode}` : ""}-${started.replaceAll(":", "-")}`
    let output: string
    let ended = started
    let loadAfter = loadBefore
    let pressureAfter = pressureBefore
    let diagnostics: Awaited<ReturnType<typeof collectScaleDiagnostics>> | undefined
    try {
      output = await tool(command)
    } finally {
      ended = new Date().toISOString()
      loadAfter = await readFile("/proc/loadavg", "utf8")
      pressureAfter = await pressureSnapshot()
      diagnostics = await collectScaleDiagnostics(directory, prefix, started, ended, (service, since, until) => {
        const id = containerStates.find((state) => state.Service === service)?.ID
        if (id === undefined) return Promise.reject(new CaptureError("container_missing", null, ""))
        return captureCommand(
          "docker",
          ["--host", target, "logs", "--timestamps", "--since", since, "--until", until, "--tail", "50000", id],
          { env }
        )
      }).catch(() => undefined)
      console.error(
        JSON.stringify({
          event: "scale_diagnostics",
          filename: diagnostics ? `${prefix}-diagnostics.json` : null,
          status: diagnostics
            ? diagnostics.sources.every((source) => source.status === "saved")
              ? "saved"
              : "partial"
            : "unavailable"
        })
      )
    }
    const parsed: unknown = JSON.parse(output)
    const metadata = {
      revision: commit,
      dirty,
      startedAt: started,
      endedAt: ended,
      host: {
        hostname: hostname(),
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
        memoryBytes: totalmem(),
        os: `${platform()} ${release()}`
      },
      project,
      actualResources,
      storageConditions: { kind: "HDD (user-reported)", freeBytes: disk.bavail * disk.bsize },
      loadBefore: loadBefore.trim(),
      loadAfter: loadAfter.trim(),
      pressure: {
        before: pressureBefore,
        after: pressureAfter,
        unit: "cumulative host stall microseconds; compare deltas, not absolute totals"
      },
      diagnostics: diagnostics ?? { status: "unavailable" },
      containers: containers
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
      budget: { api: { cpus: 1, memoryGiB: 1 }, db: { cpus: 1, memoryGiB: 3 }, generator: { cpus: 1, memoryMiB: 512 } },
      measurement: parsed
    }
    const text = JSON.stringify(metadata, null, 2)
    const filename = `${prefix}.json`
    await writeFile(join(directory, filename), text + "\n")
    await writeFile(join(directory, "latest.json"), text + "\n")
    const summary = `# ${project}: ${command}\n\nRevision: ${commit}${dirty ? " (dirty tree)" : ""}\n\nStarted: ${started}\n\nAPI + database: 2 CPUs / 4 GiB; separate generator: 1 CPU / 512 MiB.\n\n${summarizeBenchmark(parsed)}\nFull results: ${filename}\nDiagnostics: ${diagnostics ? `${prefix}-diagnostics.json` : "unavailable"}\n\n\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\`\n`
    await writeFile(join(directory, "latest.md"), summary)
    console.log(summary)
    if (command !== "plans") {
      const verdict = Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Struct({ passed: Schema.Boolean }) }))(
        parsed
      )
      if (!verdict.result.passed) process.exitCode = 1
    }
  } finally {
    await unlink(lock)
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Scale orchestration failed.")
  process.exitCode = 1
})
