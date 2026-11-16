import { Effect, Schema } from "effect"
import { Actor, Project, ProjectQuery } from "../domain/models.js"
import { Database, page, paginated, rows } from "./database.js"

const Collection = Schema.Struct({ items: Schema.Array(Project), total: Schema.Int })
// Recursive UNION deduplicates identities. Only Done intermediates require propagation:
// dependents of a non-Done node are already in the initial blocked set.
// Correlated OFFSET 0 lookups keep recursive joins from expanding to company-wide
// hash scans or quadratic joins when task cardinalities are underestimated.
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
  // Name/date paging does not depend on summaries; aggregate only its selected projects.
  // Derived sorting/filtering still examines every visible project before pagination.
  const allSummaries =
    query.hasLate !== undefined || query.sort === "completionPercentage" || query.sort === "lateCount"
  // An unfiltered SuperAdmin view can aggregate first and discard deleted-project
  // groups at the visible-project join, avoiding a membership probe per task.
  const companySummary = actor.user.role === "SuperAdmin" && id === undefined && (query.search ?? "") === ""
  const summaryTasks = allSummaries
    ? sql`SELECT t.project_id,t.status,t.start_date,t.end_date FROM tasks t WHERE t.deleted_at IS NULL ${companySummary ? sql`` : sql`AND t.project_id IN (SELECT id FROM visible)`}`
    : sql`SELECT t.* FROM candidates p CROSS JOIN LATERAL (SELECT id,project_id,status,start_date,end_date FROM tasks WHERE project_id=p.id AND deleted_at IS NULL OFFSET 0) t`
  const found = yield* rows(
    Collection,
    sql`WITH RECURSIVE visible AS (
    SELECT p.* FROM projects p WHERE p.deleted_at IS NULL AND ${id === undefined ? sql`true` : sql`p.public_id=${id}`}
    AND ${actor.user.role === "SuperAdmin" ? sql`true` : sql`EXISTS(SELECT 1 FROM memberships m WHERE m.project_id=p.id AND m.user_id=${actor.user.id})`}
    AND (strpos(lower(p.name),lower(${query.search ?? ""}))>0 OR strpos(lower(p.public_id),lower(${query.search ?? ""}))>0)
  ), candidates AS (
    SELECT p.* FROM visible p ORDER BY ${query.sort === "startDate" ? sql`p.start_date` : sql`lower(p.name)`} ${direction},p.id LIMIT ${pagination.pageSize} OFFSET ${pagination.offset}
  ), summary_tasks AS (${summaryTasks}), counts AS (
    SELECT t.project_id,count(*)::int AS total,count(*) FILTER(WHERE t.status='NotStarted')::int AS not_started,
    count(*) FILTER(WHERE t.status='InProgress')::int AS in_progress,count(*) FILTER(WHERE t.status='Done')::int AS done,
    count(*) FILTER(WHERE t.status<>'Done' AND (t.end_date<${today}::date OR (t.status='NotStarted' AND t.start_date<${today}::date)))::int AS late
    FROM summary_tasks t GROUP BY t.project_id
  ), enriched AS (
    SELECT p.*,coalesce(c.total,0) AS total_tasks,coalesce(c.not_started,0) AS not_started,coalesce(c.in_progress,0) AS in_progress,
    coalesce(c.done,0) AS done,coalesce(c.late,0) AS late_count,
    CASE WHEN coalesce(c.total,0)=0 THEN 0::numeric ELSE c.done::numeric/c.total END AS completion_ratio
    FROM visible p LEFT JOIN counts c ON c.project_id=p.id
  ), filtered AS (
    SELECT p.* FROM enriched p WHERE (${query.hasLate === undefined} OR (p.late_count>0)=${query.hasLate === "true"})
  ), selected AS (SELECT p.* FROM filtered p WHERE ${allSummaries ? sql`true` : sql`p.id IN (SELECT id FROM candidates)`} ORDER BY ${order} ${direction},p.id LIMIT ${pagination.pageSize} OFFSET ${allSummaries ? pagination.offset : 0})
  SELECT (SELECT count(*)::int FROM filtered) AS total,coalesce((SELECT jsonb_agg(jsonb_build_object(
    'id',p.public_id,'name',p.name,'startDate',p.start_date::text,'endDate',p.end_date::text,
    'isAdmin',EXISTS(SELECT 1 FROM memberships m WHERE m.project_id=p.id AND m.user_id=${actor.user.id} AND m.is_admin),
    'memberCount',(SELECT count(*)::int FROM memberships m WHERE m.project_id=p.id),
    'taskCounts',jsonb_build_object('total',p.total_tasks,'notStarted',p.not_started,'inProgress',p.in_progress,'done',p.done),
    'completionPercentage',round(100*p.completion_ratio,2)::float8,'lateCount',p.late_count,'blockedCount',bc.count
  ) ORDER BY ${order} ${direction},p.id) FROM selected p CROSS JOIN LATERAL (
    WITH RECURSIVE blocked(task_id,status) AS (
    SELECT d.id,d.status FROM tasks r
    CROSS JOIN LATERAL (SELECT dependent_id FROM task_dependencies
      WHERE project_id=p.id AND prerequisite_id=r.id OFFSET 0) e
    CROSS JOIN LATERAL (SELECT id,status FROM tasks
      WHERE project_id=p.id AND id=e.dependent_id AND deleted_at IS NULL OFFSET 0) d
    WHERE r.project_id=p.id AND r.deleted_at IS NULL AND r.status<>'Done'
    UNION
    SELECT d.id,d.status FROM blocked b
    CROSS JOIN LATERAL (SELECT dependent_id FROM task_dependencies
      WHERE project_id=p.id AND prerequisite_id=b.task_id OFFSET 0) e
    CROSS JOIN LATERAL (SELECT id,status FROM tasks
      WHERE project_id=p.id AND id=e.dependent_id AND deleted_at IS NULL OFFSET 0) d
    WHERE b.status='Done'
    )
    SELECT count(*)::int AS count FROM blocked WHERE status<>'Done'
  ) bc),'[]'::jsonb) AS items`
  )
  const result = found[0]
  if (!result) return yield* Effect.die(new Error("Missing project collection result"))
  return paginated(result.items, result.total, pagination)
})
