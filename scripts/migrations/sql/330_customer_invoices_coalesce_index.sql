-- BL-23: expression index enables the planner to use an index for
-- WHERE COALESCE(ci.client_id, ci.customer_id) = $1 (common on the
-- customer-invoices list endpoint).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ci_coalesce_client
  ON customer_invoices ((COALESCE(client_id, customer_id)));
