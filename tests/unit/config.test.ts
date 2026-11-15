import { describe, expect, it } from "vitest"
import { Effect, Redacted } from "effect"
import { readConfig, readTestConfig } from "../../src/config/config.js"

const url = "postgresql://sitetrack:example_only@127.0.0.1:5432/sitetrack"
const testUrl = "postgresql://sitetrack_test:example_only@127.0.0.1:5432/sitetrack_test"

describe("explicit configuration", () => {
  it("sets documented defaults and redacts credentials", async () => {
    const config = await Effect.runPromise(readConfig({ DATABASE_URL: url }))
    expect(config).toMatchObject({ host: "0.0.0.0", port: 3000, schema: "sitetrack" })
    expect(Redacted.value(config.databaseUrl)).toBe(url)
    expect(JSON.stringify(config)).not.toContain("example_only")
    expect(Object.isFrozen(config)).toBe(true)
  })

  it.each([
    {},
    { DATABASE_URL: "invalid" },
    { DATABASE_URL: "https://user:secret@localhost/db" },
    { DATABASE_URL: url, PORT: "1.5" },
    { DATABASE_URL: url, PORT: "65536" },
    { DATABASE_URL: url, PORT: "-1" },
    { DATABASE_URL: url, DATABASE_SCHEMA: "public;DROP" },
    { DATABASE_URL: `${url}?options=-csearch_path=public` }
  ])("rejects invalid input without exposing values", async (env) => {
    const error = await Effect.runPromise(readConfig(env).pipe(Effect.flip))
    expect(error._tag).toBe("ConfigurationError")
    expect(JSON.stringify(error)).not.toContain("example_only")
    expect(JSON.stringify(error)).not.toContain("user:secret")
  })

  it("never falls back from test to development configuration", async () => {
    await expect(
      Effect.runPromise(readTestConfig({ DATABASE_URL: url, SITETRACK_TEST_DISPOSABLE: "true" }))
    ).rejects.toThrow()
  })

  it.each([
    { TEST_DATABASE_URL: testUrl },
    { TEST_DATABASE_URL: url, SITETRACK_TEST_DISPOSABLE: "true" },
    { TEST_DATABASE_URL: testUrl.replace("127.0.0.1", "remote.example"), SITETRACK_TEST_DISPOSABLE: "true" }
  ])("refuses unapproved test configuration", async (env) => {
    await expect(Effect.runPromise(readTestConfig(env))).rejects.toThrow()
  })

  it("accepts only explicit local disposable test configuration", async () => {
    const config = await Effect.runPromise(
      readTestConfig({ TEST_DATABASE_URL: testUrl, SITETRACK_TEST_DISPOSABLE: "true" })
    )
    expect(Redacted.value(config.databaseUrl)).toBe(testUrl)
  })
})
