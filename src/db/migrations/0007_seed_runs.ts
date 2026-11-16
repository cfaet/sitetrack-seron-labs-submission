import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE seed_runs (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
    profile text NOT NULL CHECK(profile IN ('small','large')),
    generator_version integer NOT NULL, random_seed integer NOT NULL, reference_date date NOT NULL,
    state text NOT NULL CHECK(state IN ('loading','ready','failed')),
    started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
    counts jsonb, CHECK((state='ready') = (completed_at IS NOT NULL))
  )`
})
