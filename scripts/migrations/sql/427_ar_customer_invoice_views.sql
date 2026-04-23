-- PRD-06 Phase 2: Customer Portal Access Log
--
-- Per-view log for customer-facing invoice portal. One row per view whether
-- the customer clicked the portal link, the bookkeeper's tracking pixel
-- rendered in a mail client, or the sealed PDF was downloaded. Keeps the
-- existing customer_invoices.portal_viewed_at scalar (mig 300) untouched so
-- nothing that reads the scalar breaks — this table is strictly additive.
--
-- The materialised view powers the AR list "last viewed" column without a
-- per-row correlated subquery; it's refreshed nightly by the cron endpoint
-- /api/cron/ar-matview-refresh.

CREATE TABLE IF NOT EXISTS customer_invoice_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_invoice_id uuid NOT NULL REFERENCES customer_invoices(id) ON DELETE CASCADE,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  ip_address inet,
  user_agent text,
  view_source text CHECK (view_source IN ('portal', 'tracking_pixel', 'pdf_link', 'api')),
  session_token text,
  response_time_ms int
);

CREATE INDEX IF NOT EXISTS idx_cust_inv_views
  ON customer_invoice_views(customer_invoice_id, viewed_at DESC);

CREATE INDEX IF NOT EXISTS idx_cust_inv_views_session
  ON customer_invoice_views(session_token)
  WHERE session_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cust_inv_views_company
  ON customer_invoice_views(company_id, viewed_at DESC);

-- Aggregate MV for AR list UI. Must be REFRESH MATERIALIZED VIEW
-- CONCURRENTLY-able, which requires a unique index on a non-null column.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_matviews WHERE matviewname = 'customer_invoice_view_summary'
  ) THEN
    CREATE MATERIALIZED VIEW customer_invoice_view_summary AS
    SELECT customer_invoice_id,
           company_id,
           MAX(viewed_at) AS last_viewed_at,
           COUNT(*)      AS view_count,
           COUNT(DISTINCT session_token) FILTER (WHERE session_token IS NOT NULL) AS distinct_sessions
    FROM customer_invoice_views
    GROUP BY customer_invoice_id, company_id;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cust_inv_view_summary
  ON customer_invoice_view_summary(customer_invoice_id);

CREATE INDEX IF NOT EXISTS idx_cust_inv_view_summary_company
  ON customer_invoice_view_summary(company_id);

COMMENT ON TABLE customer_invoice_views IS
  'PRD-06 Phase 2 — one row per customer-facing invoice view (portal, tracking pixel, PDF download, API).';
COMMENT ON COLUMN customer_invoice_views.session_token IS
  'One-way SHA-256 hash of the portal token that served the view — never the raw token.';
COMMENT ON COLUMN customer_invoice_views.view_source IS
  'portal | tracking_pixel | pdf_link | api';

GRANT SELECT, INSERT ON customer_invoice_views TO app_user;
GRANT SELECT ON customer_invoice_view_summary TO app_user;
