import { Effect, Schema } from "effect"
import { Actor, Project, ProjectQuery } from "../domain/models.js"
import { Database, page, paginated, rows } from "./database.js"

const Collection = Schema.Struct({ items: Schema.Array(Project), total: Schema.Int })
// Recursive UNION deduplicates blocked task identities, rather than enumerating paths.
export const readProjects = Effect.fn("readProjects")(function* (
  actor: Actor,
  query: typeof ProjectQuery.Type,
  today: string,
  id?: string
) {
  const sql = yield* Database,
    pagination = page(query)
  const order =
    query.sort === "completionPercentage"
      ? sql`p.completion_ratio`
      : query.sort === "lateCount"
        ? sql`p.late_count`
        : query.sort === "startDate"
          ? sql`p.start_date`
          : sql`lower(p.name)`
  const direction = query.direction === "desc" ? sql`DESC` : sql`ASC`
  const found = yield* rows(
    Collection,
    sql`WITH RECURSIVE visible AS (
    SELECT p.* FROM projects p WHERE p.deleted_at IS NULL AND (${id === undefined} OR p.public_id=${id ?? ""})
    AND (${actor.user.role === "SuperAdmin"} OR EXISTS(SELECT 1 FROM memberships m WHERE m.project_id=p.id AND m.user_id=${actor.user.id}))
    AND (strpos(lower(p.name),lower(${query.search ?? ""}))>0 OR strpos(lower(p.public_id),lower(${query.search ?? ""}))>0)
  ), active AS (
    SELECT t.* FROM tasks t JOIN visible p ON p.id=t.project_id WHERE t.deleted_at IS NULL
  ), blocked(task_id,project_id) AS (
    SELECT e.dependent_id,e.project_id FROM task_dependencies e
    JOIN visible p ON p.id=e.project_id JOIN tasks d ON d.id=e.dependent_id JOIN tasks r ON r.id=e.prerequisite_id
    WHERE d.deleted_at IS NULL AND r.deleted_at IS NULL AND r.status<>'Done'
    UNION
    SELECT e.dependent_id,e.project_id FROM task_dependencies e JOIN blocked b ON b.task_id=e.prerequisite_id AND b.project_id=e.project_id
    JOIN tasks d ON d.id=e.dependent_id WHERE d.deleted_at IS NULL
  ), counts AS (
    SELECT t.project_id,count(*)::int AS total,count(*) FILTER(WHERE t.status='NotStarted')::int AS not_started,
    count(*) FILTER(WHERE t.status='InProgress')::int AS in_progress,count(*) FILTER(WHERE t.status='Done')::int AS done,
    count(*) FILTER(WHERE t.status<>'Done' AND (t.end_date<${today}::date OR (t.status='NotStarted' AND t.start_date<${today}::date)))::int AS late,
    count(*) FILTER(WHERE t.status<>'Done' AND b.task_id IS NOT NULL)::int AS blocked
    FROM active t LEFT JOIN blocked b ON b.task_id=t.id AND b.project_id=t.project_id GROUP BY t.project_id
  ), enriched AS (
    SELECT p.*,coalesce(c.total,0) AS total_tasks,coalesce(c.not_started,0) AS not_started,coalesce(c.in_progress,0) AS in_progress,
    coalesce(c.done,0) AS done,coalesce(c.late,0) AS late_count,coalesce(c.blocked,0) AS blocked_count,
    CASE WHEN coalesce(c.total,0)=0 THEN 0::numeric ELSE c.done::numeric/c.total END AS completion_ratio
    FROM visible p LEFT JOIN counts c ON c.project_id=p.id
  ), filtered AS (
    SELECT p.* FROM enriched p WHERE (${query.hasLate === undefined} OR (p.late_count>0)=${query.hasLate === "true"})
  ), selected AS (SELECT p.* FROM filtered p ORDER BY ${order} ${direction},p.id LIMIT ${pagination.pageSize} OFFSET ${pagination.offset})
  SELECT (SELECT count(*)::int FROM filtered) AS total,coalesce((SELECT jsonb_agg(jsonb_build_object(
    'id',p.public_id,'name',p.name,'startDate',p.start_date::text,'endDate',p.end_date::text,
    'isAdmin',EXISTS(SELECT 1 FROM memberships m WHERE m.project_id=p.id AND m.user_id=${actor.user.id} AND m.is_admin),
    'memberCount',(SELECT count(*)::int FROM memberships m WHERE m.project_id=p.id),
    'taskCounts',jsonb_build_object('total',p.total_tasks,'notStarted',p.not_started,'inProgress',p.in_progress,'done',p.done),
    'completionPercentage',round(100*p.completion_ratio,2)::float8,'lateCount',p.late_count,'blockedCount',p.blocked_count
  ) ORDER BY ${order} ${direction},p.id) FROM selected p),'[]'::jsonb) AS items`
  )
  const result = found[0]
  if (!result) return yield* Effect.die(new Error("Missing project collection result"))
  return paginated(result.items, result.total, pagination)
})
