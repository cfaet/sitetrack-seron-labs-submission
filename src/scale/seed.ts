import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { ConfigurationError } from "../config/config.js"
import { rows } from "../repositories/database.js"
import { companyStoreId } from "../repositories/inventory.js"
import {
  demoPassword,
  generatorVersion,
  profiles,
  projectPlan,
  randomSeed,
  referenceDate,
  type Profile
} from "./profile.js"
import { Passwords } from "../services/security.js"

export const Manifest = Schema.Struct({
  profile: Schema.Literals(["small", "large"]),
  version: Schema.Int,
  seed: Schema.Int,
  date: Schema.String,
  state: Schema.Literals(["loading", "ready", "failed"]),
  counts: Schema.NullOr(
    Schema.Struct({
      users: Schema.Int,
      projects: Schema.Int,
      invitations: Schema.Int,
      tasks: Schema.Int,
      edges: Schema.Int,
      materials: Schema.Int,
      deliveries: Schema.Int,
      lines: Schema.Int
    })
  ),
  startedAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String)
})
export const manifest = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return yield* rows(
    Manifest,
    sql`SELECT profile,generator_version AS version,random_seed AS seed,reference_date::text AS date,state,counts,to_char(started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startedAt",to_char(completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "completedAt" FROM seed_runs`
  )
})
export const scaleLock = <A, E, R>(run: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const locked = yield* rows(
      Schema.Struct({ locked: Schema.Boolean }),
      sql`SELECT pg_try_advisory_lock(hashtextextended(current_database()||':'||current_schema()||':scale',0)) AS locked`
    )
    if (!locked[0]?.locked)
      return yield* new ConfigurationError({ message: "Another seed/check/benchmark operation owns this dataset." })
    return yield* run.pipe(
      Effect.ensuring(
        sql`SELECT pg_advisory_unlock(hashtextextended(current_database()||':'||current_schema()||':scale',0))`.pipe(
          Effect.orDie
        )
      )
    )
  })
const Count = Schema.Struct({ count: Schema.Int })
const ensureZero = Effect.fn("seed.ensureZero")(function* (
  name: string,
  query: Parameters<typeof rows<typeof Count>>[1]
) {
  yield* Effect.sync(() => process.stderr.write(JSON.stringify({ event: "seed_check", invariant: name }) + "\n"))
  const found = yield* rows(Count, query)
  if (found[0]?.count !== 0) return yield* new ConfigurationError({ message: `Dataset invariant failed: ${name}.` })
})
export const verifySeedManifest = Effect.fn("verifySeedManifest")(function* (profile: Profile, loading = false) {
  const saved = (yield* manifest)[0]
  if (
    !saved ||
    saved.profile !== profile ||
    saved.version !== generatorVersion ||
    saved.seed !== randomSeed ||
    saved.date !== referenceDate ||
    (saved.state !== "ready" && !(loading && saved.state === "loading"))
  )
    return yield* new ConfigurationError({ message: "Dataset manifest is missing, incompatible or incomplete." })
  const expected = profiles[profile]
  const savedCounts: Readonly<Record<string, number>> = saved.counts ?? {}
  if (
    saved.state === "ready" &&
    (saved.counts === null || Object.entries(expected).some(([key, value]) => savedCounts[key] !== value))
  )
    return yield* new ConfigurationError({ message: "Dataset manifest counts are inconsistent." })
})

export const movementIntegrityQuery = (sql: SqlClient.SqlClient) =>
  // One snapshot covers every delivery. Canonical UUID text in C collation has
  // the same ordering as UUID values, so these inclusive ranges never overlap.
  // Materialize each small range before joining its two movement phases: the
  // company-wide hash joins otherwise spill gigabytes; unbounded point probes
  // also repeat millions of store/movement lookups after cardinality estimates fall.
  sql`WITH ranges AS MATERIALIZED (
    SELECT min(id::text COLLATE "C")::uuid AS first_id,max(id::text COLLATE "C")::uuid AS last_id
    FROM (SELECT id,(row_number() OVER (ORDER BY id)-1)/2000 AS bucket FROM deliveries) numbered GROUP BY bucket
  )
  SELECT coalesce(sum(v.count),0)::int AS count FROM ranges r CROSS JOIN LATERAL (
    WITH scoped_deliveries AS MATERIALIZED (
      SELECT d.id,d.status,d.direction,ps.id AS project_store FROM deliveries d JOIN stores ps ON ps.project_id=d.project_id
      WHERE d.id BETWEEN r.first_id AND r.last_id
    ), scoped_lines AS MATERIALIZED (
      SELECT l.delivery_id,l.material_id,l.quantity,d.status,d.direction,d.project_store
      FROM scoped_deliveries d JOIN delivery_lines l ON l.delivery_id=d.id WHERE l.delivery_id BETWEEN r.first_id AND r.last_id
    ), dispatch AS MATERIALIZED (
      SELECT id,delivery_id,material_id,delta,store_id FROM stock_movements WHERE phase='Dispatch' AND delivery_id BETWEEN r.first_id AND r.last_id
    ), terminal AS MATERIALIZED (
      SELECT id,delivery_id,material_id,delta,store_id,kind FROM stock_movements WHERE phase='Terminal' AND delivery_id BETWEEN r.first_id AND r.last_id
    )
    SELECT count(*) AS count FROM scoped_lines l
    LEFT JOIN dispatch a ON a.delivery_id=l.delivery_id AND a.material_id=l.material_id
    LEFT JOIN terminal b ON b.delivery_id=l.delivery_id AND b.material_id=l.material_id
    WHERE a.id IS NULL OR a.delta<>-l.quantity OR a.store_id<>CASE WHEN l.direction='CompanyToProject' THEN ${companyStoreId}::uuid ELSE l.project_store END
    OR (l.status='InTransit' AND b.id IS NOT NULL) OR (l.status<>'InTransit' AND (b.id IS NULL OR b.delta<>l.quantity
      OR b.kind<>CASE l.status WHEN 'Delivered' THEN 'Receipt' WHEN 'Rejected' THEN 'RejectionRefund' ELSE 'CancellationRefund' END
      OR b.store_id<>CASE WHEN (l.direction='CompanyToProject')=(l.status='Delivered') THEN l.project_store ELSE ${companyStoreId}::uuid END))
  ) v`

export const checkSeed = Effect.fn("checkSeed")(function* (profile: Profile, loading = false) {
  yield* verifySeedManifest(profile, loading)
  const sql = yield* SqlClient.SqlClient
  const expected = profiles[profile]
  const counts: Record<string, number> = {}
  for (const [key, table] of Object.entries({
    users: "users",
    projects: "projects",
    invitations: "invitations",
    tasks: "tasks",
    edges: "task_dependencies",
    materials: "materials",
    deliveries: "deliveries",
    lines: "delivery_lines"
  })) {
    const found = yield* rows(Count, sql`SELECT count(*)::int AS count FROM ${sql(table)}`)
    counts[key] = found[0]?.count ?? -1
  }
  if (Object.entries(expected).some(([key, value]) => counts[key] !== value))
    return yield* new ConfigurationError({ message: "Dataset counts do not match the selected profile." })
  yield* ensureZero(
    "project members and counters",
    sql`SELECT count(*)::int AS count FROM projects p WHERE
    NOT EXISTS(SELECT 1 FROM memberships m WHERE m.project_id=p.id AND m.is_admin)
    OR (SELECT count(*) FROM memberships m WHERE m.project_id=p.id)>50
    OR p.task_counter<>(SELECT coalesce(max(task_number),0) FROM tasks t WHERE t.project_id=p.id)
    OR (SELECT count(*) FROM tasks t WHERE t.project_id=p.id)>3000`
  )
  // Numeric task order is a topological certificate, independently checked on every edge.
  yield* ensureZero(
    "DAG topology and started prerequisites",
    sql`SELECT count(*)::int AS count FROM task_dependencies e JOIN tasks d ON d.id=e.dependent_id JOIN tasks r ON r.id=e.prerequisite_id
    WHERE r.project_id<>d.project_id OR r.task_number>=d.task_number OR (d.first_started_at IS NOT NULL AND r.status<>'Done')`
  )
  yield* ensureZero(
    "invitation notifications and pending membership",
    sql`SELECT count(*)::int AS count FROM invitations i LEFT JOIN notifications n ON n.invitation_id=i.id WHERE n.id IS NULL OR n.recipient_id<>i.invitee_id OR (i.status='Pending' AND EXISTS(SELECT 1 FROM memberships m WHERE m.project_id=i.project_id AND m.user_id=i.invitee_id))`
  )
  yield* ensureZero(
    "delivery actor sides",
    sql`SELECT count(*)::int AS count FROM deliveries d WHERE
    d.initiated_by<>CASE WHEN d.direction='CompanyToProject' THEN '10000000-0000-4000-8000-000000000002'::uuid ELSE '10000000-0000-4000-8000-000000000003'::uuid END
    OR (d.status='Cancelled' AND d.closed_by<>d.initiated_by)
    OR (d.status IN ('Delivered','Rejected') AND d.closed_by=d.initiated_by)`
  )
  yield* ensureZero(
    "line cardinality",
    sql`SELECT count(*)::int AS count FROM (SELECT d.id,count(l.material_id) AS n FROM deliveries d LEFT JOIN delivery_lines l ON l.delivery_id=d.id GROUP BY d.id) q WHERE n NOT BETWEEN 1 AND 100`
  )
  yield* ensureZero("movement phases, quantities and destinations", movementIntegrityQuery(sql))
  yield* ensureZero(
    "balance reconciliation",
    sql`SELECT count(*)::int AS count FROM stock_balances b LEFT JOIN (SELECT store_id,material_id,sum(delta) AS quantity,max(created_at) FILTER(WHERE kind<>'Addition') AS activity FROM stock_movements GROUP BY store_id,material_id) m USING(store_id,material_id)
    WHERE b.quantity<>coalesce(m.quantity,0) OR b.last_delivery_at IS DISTINCT FROM m.activity`
  )
  yield* ensureZero(
    "historical nonnegative quantities",
    sql`SELECT count(*)::int AS count FROM (SELECT sum(delta) OVER(PARTITION BY store_id,material_id ORDER BY created_at,id ROWS UNBOUNDED PRECEDING) AS balance FROM stock_movements) h WHERE balance<0`
  )
  const seq = yield* rows(
    Schema.Struct({ next: Schema.String }),
    sql`SELECT (last_value+CASE WHEN is_called THEN 1 ELSE 0 END)::text AS next FROM project_number_seq`
  )
  if (BigInt(seq[0]?.next ?? "0") <= BigInt(expected.projects))
    return yield* new ConfigurationError({ message: "Project sequence is behind seeded identifiers." })
  return counts
})

export const loadSeed = Effect.fn("loadSeed")(function* (profile: Profile, allowed: boolean) {
  if (!allowed)
    return yield* new ConfigurationError({
      message: "Seeding requires SITETRACK_SEED_ALLOWED=true and an empty dataset."
    })
  const sql = yield* SqlClient.SqlClient
  const previous = (yield* manifest)[0]
  if (previous) return yield* checkSeed(profile)
  // Singleton company store and migration objects are the only permitted preexisting rows.
  for (const table of [
    "users",
    "projects",
    "memberships",
    "invitations",
    "notifications",
    "tasks",
    "task_dependencies",
    "materials",
    "deliveries",
    "delivery_lines",
    "stock_balances",
    "stock_movements",
    "idempotency_records",
    "sessions"
  ]) {
    yield* ensureZero(`empty ${table}`, sql`SELECT count(*)::int AS count FROM ${sql(table)}`)
  }
  yield* ensureZero(
    "only the migration-created company store",
    sql`SELECT count(*)::int AS count FROM stores WHERE id<>${companyStoreId}`
  )
  yield* sql`INSERT INTO seed_runs(profile,generator_version,random_seed,reference_date,state) VALUES (${profile},${generatorVersion},${randomSeed},${referenceDate},'loading')`
  return yield* Effect.gen(function* () {
    const c = profiles[profile],
      perProject = c.deliveries / c.projects,
      extra = c.lines - 7 * c.deliveries - 13 * c.projects
    const passwords = yield* Passwords
    const hash = yield* passwords.hash(demoPassword)
    const progress = (phase: string) =>
      Effect.sync(() => process.stderr.write(JSON.stringify({ event: "seed_progress", profile, phase }) + "\n"))
    yield* sql`CREATE TEMP TABLE seed_projects(number int,tasks int,"offset" int,edges int,members int) ON COMMIT PRESERVE ROWS`
    yield* sql`INSERT INTO seed_projects SELECT * FROM jsonb_to_recordset(${JSON.stringify(projectPlan(profile))}::jsonb) AS x(number int,tasks int,"offset" int,edges int,members int)`
    yield* sql`INSERT INTO users(id,name,email,password_hash,role,created_at) SELECT ('10000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,
      'Demo user '||i,'user'||i||'@sitetrack.example',${hash},CASE i WHEN 1 THEN 'SuperAdmin' WHEN 2 THEN 'CompanyStoreManager' ELSE 'User' END,${referenceDate}::date-interval '2 years' FROM generate_series(1,${c.users}) i`
    yield* sql`INSERT INTO projects(id,project_number,name,start_date,end_date,task_counter) SELECT ('20000000-0000-4000-8000-'||lpad(number::text,12,'0'))::uuid,number,'Project '||lpad(number::text,4,'0'),${referenceDate}::date-365,${referenceDate}::date+365,tasks FROM seed_projects`
    yield* sql`SELECT setval('project_number_seq',${c.projects}::bigint,true)`
    yield* sql`INSERT INTO stores(id,project_id) SELECT ('30000000-0000-4000-8000-'||lpad(number::text,12,'0'))::uuid,('20000000-0000-4000-8000-'||lpad(number::text,12,'0'))::uuid FROM seed_projects`
    yield* sql`INSERT INTO memberships(project_id,user_id,is_admin) SELECT ('20000000-0000-4000-8000-'||lpad(p.number::text,12,'0'))::uuid,
      ('10000000-0000-4000-8000-'||lpad((CASE WHEN j=0 THEN 3 ELSE 4+((p.number-1)*17+j-1)%(${c.users}-3) END)::text,12,'0'))::uuid,j=0 FROM seed_projects p CROSS JOIN LATERAL generate_series(0,p.members-1) j`
    yield* sql`INSERT INTO invitations(id,project_id,invitee_id,inviter_id,status,created_at) SELECT ('60000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,
      ('20000000-0000-4000-8000-'||lpad(p.number::text,12,'0'))::uuid,
      ('10000000-0000-4000-8000-'||lpad((4+((p.number-1)*17+p.members+((i-1)%25))%(${c.users}-3))::text,12,'0'))::uuid,
      '10000000-0000-4000-8000-000000000003'::uuid,(ARRAY['Pending','Accepted','Rejected','Withdrawn'])[1+(i%4)],${referenceDate}::date-(i%180)*interval '1 day'
      FROM generate_series(1,${c.invitations}) i JOIN seed_projects p ON p.number=1+(i-1)/25`
    yield* sql`INSERT INTO notifications(id,invitation_id,recipient_id,created_at,read_at) SELECT ('70000000-0000-4000-8000-'||right(id::text,12))::uuid,id,invitee_id,created_at,CASE WHEN right(id::text,1)::int%3=0 THEN created_at+interval '1 hour' END FROM invitations`
    yield* progress("identity")
    for (let begin = 1; begin <= c.projects; begin += 25) {
      yield* sql`INSERT INTO tasks(id,project_id,task_number,public_id,name,start_date,end_date,status,first_started_at)
        SELECT ('40000000-0000-4000-8000-'||lpad((p."offset"+n)::text,12,'0'))::uuid,('20000000-0000-4000-8000-'||lpad(p.number::text,12,'0'))::uuid,
        n,'PRJ-'||lpad(p.number::text,4,'0')||'-T-'||lpad(n::text,4,'0'),'Task '||lpad(n::text,4,'0'),${referenceDate}::date-90+(n%120),${referenceDate}::date-60+(n%120),
        CASE WHEN n<=p.tasks*3/10 THEN 'Done' WHEN n=p.tasks*3/10+1 THEN 'InProgress' ELSE 'NotStarted' END,
        CASE WHEN n<=p.tasks*3/10+1 THEN ${referenceDate}::date-120+least((n+${randomSeed})%120,90)*interval '1 day' END
        FROM seed_projects p CROSS JOIN LATERAL generate_series(1,p.tasks) n WHERE p.number BETWEEN ${begin} AND ${begin + 24}`
      yield* sql`INSERT INTO task_dependencies(project_id,dependent_id,prerequisite_id)
        SELECT ('20000000-0000-4000-8000-'||lpad(p.number::text,12,'0'))::uuid,
        ('40000000-0000-4000-8000-'||lpad((p."offset"+e.n)::text,12,'0'))::uuid,
        ('40000000-0000-4000-8000-'||lpad((p."offset"+e.r)::text,12,'0'))::uuid
        FROM seed_projects p CROSS JOIN LATERAL (
          SELECT n,CASE WHEN p.number=2 AND k=1 THEN 1 ELSE n-k END AS r FROM generate_series(1,5) k CROSS JOIN LATERAL generate_series(k+1,p.tasks) n
          WHERE (p.number<>1 OR k=1) AND NOT(p.number=2 AND k>1 AND n-k=1) ORDER BY k,n LIMIT p.edges
        ) e WHERE p.number BETWEEN ${begin} AND ${begin + 24}`
    }
    yield* progress("tasks_and_edges")
    yield* sql`INSERT INTO materials(id,name,category,unit) SELECT ('50000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'Material '||lpad(i::text,5,'0'),'Category '||(i%12),CASE WHEN i%2=0 THEN 'kg' ELSE 'm' END FROM generate_series(1,${c.materials}) i`
    for (let begin = 1; begin <= c.deliveries; begin += 2000) {
      yield* sql`INSERT INTO deliveries(id,project_id,direction,status,initiated_at,initiated_by,closed_at,closed_by)
        SELECT ('80000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,('20000000-0000-4000-8000-'||lpad((1+(i-1)/${perProject})::text,12,'0'))::uuid,
        CASE WHEN (i-1)%${perProject}>0 AND i%3=0 THEN 'ProjectToCompany' ELSE 'CompanyToProject' END,
        CASE WHEN (i-1)%${perProject}=0 THEN 'Delivered' ELSE (ARRAY['InTransit','Delivered','Rejected','Cancelled'])[1+i%4] END,
        ${referenceDate}::date-${perProject}+((i-1)%${perProject})*interval '1 day',
        CASE WHEN (i-1)%${perProject}>0 AND i%3=0 THEN '10000000-0000-4000-8000-000000000003'::uuid ELSE '10000000-0000-4000-8000-000000000002'::uuid END,
        CASE WHEN (i-1)%${perProject}=0 OR i%4<>0 THEN ${referenceDate}::date-${perProject}+((i-1)%${perProject})*interval '1 day'+interval '1 hour' END,
        CASE WHEN (i-1)%${perProject}=0 OR i%4<>0 THEN CASE WHEN ((i-1)%${perProject}>0 AND i%3=0) <> ((i-1)%${perProject}>0 AND i%4=3) THEN '10000000-0000-4000-8000-000000000002'::uuid ELSE '10000000-0000-4000-8000-000000000003'::uuid END END
        FROM generate_series(${begin},${Math.min(c.deliveries, begin + 1999)}) i`
      yield* sql`INSERT INTO delivery_lines(delivery_id,material_id,material_name,unit,quantity)
        SELECT ('80000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,m.id,m.name,m.unit,
        CASE WHEN (i-1)%${perProject}=0 THEN 1000.000001 ELSE 1.000001 END
        FROM generate_series(${begin},${Math.min(c.deliveries, begin + 1999)}) i
        CROSS JOIN LATERAL generate_series(1,CASE WHEN (i-1)%${perProject}=0 THEN 20 ELSE 7+CASE WHEN i-1-(i-1)/${perProject}<=${extra} THEN 1 ELSE 0 END END) j
        JOIN materials m ON m.id=('50000000-0000-4000-8000-'||lpad((1+(((i-1)/${perProject})*7+j-1)%${c.materials})::text,12,'0'))::uuid`
      if (begin === 1 || begin % 20000 === 1) yield* progress(`deliveries_${Math.min(c.deliveries, begin + 1999)}`)
    }
    yield* sql`INSERT INTO stock_balances(store_id,material_id,quantity,reorder_point) SELECT ${companyStoreId},m.id,
      CASE WHEN EXISTS(SELECT 1 FROM delivery_lines l WHERE l.material_id=m.id) THEN 1000000000 ELSE CASE WHEN right(m.id::text,12)::int%3=0 THEN 0 WHEN right(m.id::text,12)::int%3=1 THEN 5 ELSE 100 END END,10 FROM materials m`
    yield* sql`INSERT INTO stock_balances(store_id,material_id) SELECT DISTINCT s.id,l.material_id FROM delivery_lines l JOIN deliveries d ON d.id=l.delivery_id JOIN stores s ON s.project_id=d.project_id`
    yield* sql`INSERT INTO stock_movements(id,store_id,material_id,delta,kind,actor_id,created_at)
      SELECT ('a0000000-0000-4000-8000-'||right(material_id::text,12))::uuid,store_id,material_id,quantity,'Addition','10000000-0000-4000-8000-000000000002',${referenceDate}::date-interval '2 years' FROM stock_balances WHERE store_id=${companyStoreId} AND quantity>0`
    for (let begin = 1; begin <= c.deliveries; begin += 2000) {
      yield* sql`INSERT INTO stock_movements(id,store_id,material_id,delta,kind,delivery_id,phase,actor_id,created_at)
        SELECT ('90000000-0000-4000-8000-'||lpad((right(d.id::text,12)::bigint*200+((right(l.material_id::text,12)::int-1-(p.project_number-1)*7%${c.materials}+${c.materials})%${c.materials}+1)*2+phase)::text,12,'0'))::uuid,
        CASE WHEN phase=0 THEN CASE WHEN d.direction='CompanyToProject' THEN ${companyStoreId}::uuid ELSE s.id END
          WHEN (d.direction='CompanyToProject')=(d.status='Delivered') THEN s.id ELSE ${companyStoreId}::uuid END,
        l.material_id,CASE WHEN phase=0 THEN -l.quantity ELSE l.quantity END,
        CASE WHEN phase=0 THEN 'Dispatch' WHEN d.status='Delivered' THEN 'Receipt' WHEN d.status='Rejected' THEN 'RejectionRefund' ELSE 'CancellationRefund' END,
        d.id,CASE WHEN phase=0 THEN 'Dispatch' ELSE 'Terminal' END,CASE WHEN phase=0 THEN d.initiated_by ELSE d.closed_by END,
        CASE WHEN phase=0 THEN d.initiated_at ELSE d.closed_at END
        FROM deliveries d JOIN projects p ON p.id=d.project_id JOIN stores s ON s.project_id=p.id JOIN delivery_lines l ON l.delivery_id=d.id
        CROSS JOIN LATERAL generate_series(0,CASE WHEN d.status='InTransit' THEN 0 ELSE 1 END) phase
        WHERE d.id BETWEEN ('80000000-0000-4000-8000-'||lpad(${String(begin)},12,'0'))::uuid AND ('80000000-0000-4000-8000-'||lpad(${String(Math.min(c.deliveries, begin + 1999))},12,'0'))::uuid`
      if (begin === 1 || begin % 20000 === 1) yield* progress(`movements_${Math.min(c.deliveries, begin + 1999)}`)
    }
    yield* sql`UPDATE stock_balances b SET quantity=m.quantity,last_delivery_at=m.activity FROM (SELECT store_id,material_id,sum(delta) AS quantity,max(created_at) FILTER(WHERE kind<>'Addition') AS activity FROM stock_movements GROUP BY store_id,material_id) m WHERE b.store_id=m.store_id AND b.material_id=m.material_id`
    yield* sql`ANALYZE`
    yield* progress("checking")
    const counts = yield* checkSeed(profile, true)
    yield* sql`UPDATE seed_runs SET state='ready',completed_at=now(),counts=${JSON.stringify(counts)}::jsonb`
    yield* progress("ready")
    return counts
  }).pipe(Effect.onError(() => sql`UPDATE seed_runs SET state='failed' WHERE state='loading'`.pipe(Effect.orDie)))
})
