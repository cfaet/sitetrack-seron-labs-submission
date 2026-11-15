import { Effect } from "effect"
import { SqlClient } from "effect/sql"
export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE projects (
    id uuid PRIMARY KEY, project_number bigint NOT NULL UNIQUE DEFAULT nextval('project_number_seq'),
    public_id text GENERATED ALWAYS AS ('PRJ-' || lpad(project_number::text, greatest(4,length(project_number::text)), '0')) STORED UNIQUE,
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200), start_date date NOT NULL, end_date date NOT NULL,
    task_counter bigint NOT NULL DEFAULT 0 CHECK (task_counter >= 0), deleted_at timestamptz,
    CHECK (start_date <= end_date), CHECK (project_number > 0)
  )`
  yield* sql`CREATE TABLE memberships (
    project_id uuid NOT NULL REFERENCES projects(id), user_id uuid NOT NULL REFERENCES users(id),
    is_admin boolean NOT NULL DEFAULT false, PRIMARY KEY (project_id,user_id)
  )`
  yield* sql`CREATE INDEX memberships_user_idx ON memberships(user_id,project_id)`
  yield* sql`CREATE TABLE stores (id uuid PRIMARY KEY, project_id uuid UNIQUE REFERENCES projects(id))`
  yield* sql`CREATE UNIQUE INDEX stores_company_singleton ON stores((project_id IS NULL)) WHERE project_id IS NULL`
  yield* sql`INSERT INTO stores(id,project_id) VALUES ('00000000-0000-4000-8000-000000000001',NULL)`
  yield* sql`CREATE INDEX projects_name_idx ON projects(lower(name),id) WHERE deleted_at IS NULL`
  yield* sql`CREATE INDEX projects_start_idx ON projects(start_date,id) WHERE deleted_at IS NULL`
})
