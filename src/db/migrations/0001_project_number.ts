import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Numbers are never reset by normal startup or migrations.
export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE SEQUENCE project_number_seq AS bigint START WITH 1 NO CYCLE`
})
