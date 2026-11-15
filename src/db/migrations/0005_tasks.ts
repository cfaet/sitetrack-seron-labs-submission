import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE tasks (
    id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id),
    task_number bigint NOT NULL CHECK (task_number > 0), public_id text NOT NULL UNIQUE,
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
    start_date date NOT NULL, end_date date NOT NULL, status text NOT NULL DEFAULT 'NotStarted'
      CHECK (status IN ('NotStarted','InProgress','Done')),
    first_started_at timestamptz, deleted_at timestamptz,
    UNIQUE(project_id,task_number), UNIQUE(project_id,id),
    CHECK (start_date <= end_date), CHECK ((status = 'NotStarted') = (first_started_at IS NULL))
  )`
  yield* sql`CREATE TABLE task_dependencies (
    project_id uuid NOT NULL, dependent_id uuid NOT NULL, prerequisite_id uuid NOT NULL,
    PRIMARY KEY(project_id,dependent_id,prerequisite_id), CHECK (dependent_id <> prerequisite_id),
    FOREIGN KEY(project_id,dependent_id) REFERENCES tasks(project_id,id),
    FOREIGN KEY(project_id,prerequisite_id) REFERENCES tasks(project_id,id)
  )`
  yield* sql`CREATE INDEX task_dependencies_reverse_idx ON task_dependencies(project_id,prerequisite_id,dependent_id)`
  yield* sql`CREATE INDEX tasks_active_number_idx ON tasks(project_id,task_number,id) WHERE deleted_at IS NULL`
  yield* sql`CREATE INDEX tasks_active_status_idx ON tasks(project_id,status,id) WHERE deleted_at IS NULL`
})
