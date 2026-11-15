import { Effect } from "effect"
import { SqlClient } from "effect/sql"
export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE invitations (
    id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id),
    invitee_id uuid NOT NULL REFERENCES users(id), inviter_id uuid NOT NULL REFERENCES users(id),
    status text NOT NULL CHECK (status IN ('Pending','Accepted','Rejected','Withdrawn')), created_at timestamptz NOT NULL,
    CHECK (invitee_id <> inviter_id)
  )`
  yield* sql`CREATE UNIQUE INDEX invitations_pending_unique ON invitations(project_id,invitee_id) WHERE status = 'Pending'`
  yield* sql`CREATE INDEX invitations_project_idx ON invitations(project_id,created_at DESC,id)`
  yield* sql`CREATE INDEX invitations_recipient_idx ON invitations(invitee_id,status,created_at DESC)`
  yield* sql`CREATE TABLE notifications (
    id uuid PRIMARY KEY, invitation_id uuid NOT NULL UNIQUE REFERENCES invitations(id),
    recipient_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL, read_at timestamptz
  )`
  yield* sql`CREATE INDEX notifications_recipient_idx ON notifications(recipient_id,created_at DESC,id DESC)`
  yield* sql`CREATE INDEX notifications_unread_idx ON notifications(recipient_id) WHERE read_at IS NULL`
})
