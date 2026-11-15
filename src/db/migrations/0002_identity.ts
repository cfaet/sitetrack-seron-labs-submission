import { Effect } from "effect"
import { SqlClient } from "effect/sql"
export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE users (
    id uuid PRIMARY KEY, name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    email text NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND length(email) <= 254),
    password_hash text NOT NULL, role text NOT NULL CHECK (role IN ('User','CompanyStoreManager','SuperAdmin')),
    created_at timestamptz NOT NULL
  )`
  yield* sql`CREATE TABLE sessions (
    id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), refresh_hash text NOT NULL,
    created_at timestamptz NOT NULL, idle_expires_at timestamptz NOT NULL,
    absolute_expires_at timestamptz NOT NULL, revoked_at timestamptz,
    CHECK (idle_expires_at <= absolute_expires_at)
  )`
  yield* sql`CREATE INDEX sessions_user_idx ON sessions(user_id)`
})
