set dotenv-load := false

# List available recipes.
default:
    @just --list

# Watch the application source for changes.
dev:
    npm run dev

# Run previously built output; run `just build` first.
start:
    npm start

# Check application, test, and Vitest configuration types.
typecheck:
    npm run typecheck

# Compile application source to dist/.
build:
    npm run build

# Run database-free first-party tests once; an empty suite fails.
test:
    npm test

# Watch first-party tests for changes.
test-watch:
    npm run test:watch

# Check first-party code with Effect-aware linting; warnings are non-blocking.
lint:
    npm run lint

# Apply ordinary lint fixes; review the resulting diff.
lint-fix:
    npm run lint:fix

# Format first-party TypeScript and selected JSON configuration.
fmt:
    npm run fmt

# Check formatting without writing files.
fmt-check:
    npm run fmt:check

# Check formatting, lint, type-check, test, then build; stop on failure.
check:
    npm run check

# Run real PostgreSQL tests with explicit disposable test configuration.
test-integration:
    npm run test:integration

# Inspect the development connection and migration ledger without changing data.
db-check:
    npm run db:check

# Inspect the explicitly configured test connection without changing data.
db-test-check:
    npm run db:test:check

# Apply pending migrations to the explicitly configured development database.
db-migrate:
    npm run db:migrate

# Build and start the self-contained reviewer environment.
compose-up:
    docker compose up --build

# Stop reviewer services; retain database volumes.
compose-down:
    docker compose down

# Follow reviewer service logs.
compose-logs:
    docker compose logs --follow

# Validate the Compose definition without starting services or printing values.
compose-check:
    docker compose config --quiet
