import { Effect, Schema } from "effect"
import { Actor } from "../domain/models.js"
import { TaskEdge, TaskNode } from "../domain/task-models.js"
import { makeGraph } from "../domain/tasks.js"
import { notFound } from "../domain/errors.js"
import { Database, rows } from "./database.js"

const Snapshot = Schema.Struct({
  projectId: Schema.String,
  tasks: Schema.Array(TaskNode),
  edges: Schema.Array(TaskEdge)
})
// One statement supplies visibility, nodes and edges from the same PostgreSQL snapshot.
export const loadTaskGraph = Effect.fn("loadTaskGraph")(function* (actor: Actor, projectId: string) {
  const sql = yield* Database
  const found = yield* rows(
    Snapshot,
    sql`WITH visible AS (
    SELECT p.id,p.public_id FROM projects p WHERE p.public_id=${projectId} AND p.deleted_at IS NULL
    AND (${actor.user.role === "SuperAdmin"} OR EXISTS(SELECT 1 FROM memberships m WHERE m.project_id=p.id AND m.user_id=${actor.user.id}))
  ), nodes AS (SELECT t.* FROM tasks t JOIN visible p ON p.id=t.project_id WHERE t.deleted_at IS NULL)
  SELECT p.public_id AS "projectId",coalesce((SELECT jsonb_agg(jsonb_build_object(
    'id',t.public_id,'internalId',t.id,'number',t.task_number::text,'name',t.name,
    'startDate',t.start_date::text,'endDate',t.end_date::text,'status',t.status,
    'firstStartedAt',to_char(t.first_started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY t.task_number,t.id) FROM nodes t),'[]'::jsonb) AS tasks,
    coalesce((SELECT jsonb_agg(jsonb_build_object('dependent',d.public_id,'prerequisite',r.public_id) ORDER BY d.task_number,r.task_number)
    FROM task_dependencies e JOIN nodes d ON d.id=e.dependent_id JOIN nodes r ON r.id=e.prerequisite_id WHERE e.project_id=p.id),'[]'::jsonb) AS edges FROM visible p`
  )
  const snapshot = found[0]
  if (!snapshot) return yield* notFound()
  return makeGraph(snapshot.tasks, snapshot.edges)
})
