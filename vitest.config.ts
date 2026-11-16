import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    passWithNoTests: false,
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.{test,spec}.ts"],
          exclude: [...configDefaults.exclude, "repos/**", "dist/**", "coverage/**"]
        }
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.{test,spec}.ts"],
          exclude: [...configDefaults.exclude, "repos/**", "dist/**", "coverage/**"],
          fileParallelism: false,
          testTimeout: 90000,
          hookTimeout: 90000
        }
      }
    ],
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["repos/**", "node_modules/**", "dist/**", "coverage/**"]
    }
  }
})
