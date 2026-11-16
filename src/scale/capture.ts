import { spawn } from "node:child_process"

export type CaptureFailure =
  | "timeout"
  | "command_failed"
  | "spawn_failed"
  | "container_missing"
  | "output_limit"
  | "interrupted"
  | "unknown"

// Raw output is transient and must pass through the diagnostic allowlist before persistence.
export class CaptureError extends Error {
  constructor(
    readonly reason: CaptureFailure,
    readonly exitCode: number | null,
    readonly output: string
  ) {
    super(`Diagnostic capture failed: ${reason}.`)
  }
}

export const captureCommand = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly env: NodeJS.ProcessEnv; readonly timeoutMs?: number; readonly maxBytes?: number }
) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(command, [...args], { env: options.env, stdio: ["ignore", "pipe", "pipe"] })
    const chunks: Array<Buffer> = []
    const maxBytes = options.maxBytes ?? 16 * 1024 * 1024
    let size = 0,
      reason: CaptureFailure | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const stop = (failure: CaptureFailure) => {
      if (reason !== undefined) return
      reason = failure
      child.kill("SIGTERM")
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1000)
    }
    const timer = setTimeout(() => stop("timeout"), options.timeoutMs ?? 30000)
    const interrupted = () => stop("interrupted")
    process.once("SIGINT", interrupted)
    process.once("SIGTERM", interrupted)
    const cleanup = () => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      process.removeListener("SIGINT", interrupted)
      process.removeListener("SIGTERM", interrupted)
    }
    const collect = (chunk: Buffer) => {
      const remaining = maxBytes - size
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining)
        chunks.push(kept)
        size += kept.length
      }
      if (chunk.length > remaining) stop("output_limit")
    }
    child.stdout.on("data", collect)
    child.stderr.on("data", collect)
    child.once("error", () => {
      cleanup()
      reject(new CaptureError("spawn_failed", null, Buffer.concat(chunks).toString("utf8")))
    })
    child.once("close", (code) => {
      cleanup()
      const output = Buffer.concat(chunks).toString("utf8")
      if (code === 0 && reason === undefined) resolve(output)
      else reject(new CaptureError(reason ?? "command_failed", code, output))
    })
  })
