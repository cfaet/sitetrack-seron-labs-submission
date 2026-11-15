import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE materials (
    id uuid PRIMARY KEY, name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 200),
    category text NOT NULL CHECK(length(btrim(category)) BETWEEN 1 AND 100),
    unit text NOT NULL CHECK(length(btrim(unit)) BETWEEN 1 AND 40), deleted_at timestamptz
  )`
  yield* sql`CREATE INDEX materials_active_name_idx ON materials(lower(name),id) WHERE deleted_at IS NULL`
  yield* sql`CREATE INDEX materials_active_category_idx ON materials(lower(category),id) WHERE deleted_at IS NULL`
  yield* sql`CREATE TABLE stock_balances (
    store_id uuid NOT NULL REFERENCES stores(id), material_id uuid NOT NULL REFERENCES materials(id),
    quantity numeric(20,6) NOT NULL DEFAULT 0 CHECK(quantity >= 0 AND quantity <= 99999999999999.999999),
    reorder_point numeric(20,6) NOT NULL DEFAULT 0 CHECK(reorder_point >= 0 AND reorder_point <= 99999999999999.999999),
    last_delivery_at timestamptz, PRIMARY KEY(store_id,material_id)
  )`
  yield* sql`CREATE INDEX stock_material_idx ON stock_balances(material_id,store_id)`
  yield* sql`CREATE TABLE deliveries (
    id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id),
    direction text NOT NULL CHECK(direction IN ('CompanyToProject','ProjectToCompany')),
    status text NOT NULL DEFAULT 'InTransit' CHECK(status IN ('InTransit','Delivered','Rejected','Cancelled')),
    initiated_at timestamptz NOT NULL, initiated_by uuid NOT NULL REFERENCES users(id),
    closed_at timestamptz, closed_by uuid REFERENCES users(id),
    CHECK((status='InTransit' AND closed_at IS NULL AND closed_by IS NULL) OR
      (status<>'InTransit' AND closed_at IS NOT NULL AND closed_by IS NOT NULL))
  )`
  yield* sql`CREATE INDEX deliveries_project_date_idx ON deliveries(project_id,initiated_at DESC,id DESC)`
  yield* sql`CREATE INDEX deliveries_date_idx ON deliveries(initiated_at DESC,id DESC)`
  yield* sql`CREATE INDEX deliveries_transit_idx ON deliveries(project_id,id) WHERE status='InTransit'`
  yield* sql`CREATE TABLE delivery_lines (
    delivery_id uuid NOT NULL REFERENCES deliveries(id), material_id uuid NOT NULL REFERENCES materials(id),
    material_name text NOT NULL, unit text NOT NULL,
    quantity numeric(20,6) NOT NULL CHECK(quantity > 0 AND quantity <= 99999999999999.999999),
    PRIMARY KEY(delivery_id,material_id)
  )`
  yield* sql`CREATE INDEX delivery_lines_material_idx ON delivery_lines(material_id,delivery_id)`
  yield* sql`CREATE TABLE stock_movements (
    id uuid PRIMARY KEY, store_id uuid NOT NULL, material_id uuid NOT NULL,
    delta numeric(20,6) NOT NULL CHECK(delta <> 0 AND delta BETWEEN -99999999999999.999999 AND 99999999999999.999999),
    kind text NOT NULL CHECK(kind IN ('Addition','Dispatch','Receipt','RejectionRefund','CancellationRefund')),
    delivery_id uuid, phase text, actor_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL,
    FOREIGN KEY(store_id,material_id) REFERENCES stock_balances(store_id,material_id),
    FOREIGN KEY(delivery_id,material_id) REFERENCES delivery_lines(delivery_id,material_id),
    UNIQUE(delivery_id,material_id,phase),
    CHECK((kind='Addition' AND delta>0 AND delivery_id IS NULL AND phase IS NULL) OR
      (kind='Dispatch' AND delta<0 AND delivery_id IS NOT NULL AND phase IS NOT NULL AND phase='Dispatch') OR
      (kind IN ('Receipt','RejectionRefund','CancellationRefund') AND delta>0 AND delivery_id IS NOT NULL AND phase IS NOT NULL AND phase='Terminal'))
  )`
  yield* sql`CREATE INDEX stock_movements_material_idx ON stock_movements(material_id,store_id)`
  yield* sql`CREATE INDEX stock_movements_store_idx ON stock_movements(store_id,material_id,created_at DESC)`
  yield* sql`CREATE TABLE idempotency_records (
    actor_id uuid NOT NULL REFERENCES users(id), operation text NOT NULL,
    key text NOT NULL CHECK(length(key) BETWEEN 1 AND 128), fingerprint text NOT NULL,
    response_status integer NOT NULL CHECK(response_status IN (200,201)), response jsonb NOT NULL,
    PRIMARY KEY(actor_id,operation,key)
  )`
})
