-- Migration 999d: HTTP idempotency keys (audit 2026-11-15, bank WP2 row 7).
--
-- A typed bank transfer and a manual bank transaction each post a journal. A double-click or a retry after a
-- timeout posted it twice. The browser now sends an `Idempotency-Key` (a UUID made when the form opens); the route
-- claims (company_id, route, key) FIRST, in the request transaction, and stores the first success so a repeat gets
-- the same status and body with no second journal. payload_hash refuses the same key on a different body.
--
-- A row is kept only for a 2xx answer: a refusal (4xx) deletes its claim before the request commits, so the person
-- can correct the form and resend under the same key. A 5xx rolls the whole request back, claim included.
-- A concurrent duplicate blocks on the unique index until the first request commits or rolls back.
--
-- No retention job yet: rows are small (one per submitted form). Prune by created_at when it matters.

CREATE TABLE IF NOT EXISTS http_idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  route text NOT NULL,
  idempotency_key text NOT NULL,
  payload_hash text NOT NULL,
  status_code integer,
  response_body jsonb,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS http_idempotency_keys_company_route_key_uniq
  ON http_idempotency_keys (company_id, route, idempotency_key);

-- Tenant isolation — mirror of mig 507 / 514 (helpers from mig 348).
ALTER TABLE http_idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE http_idempotency_keys FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON http_idempotency_keys;
CREATE POLICY tenant_isolation ON http_idempotency_keys
  FOR ALL
  USING (company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id());

-- The claim is inserted, then updated with the result (2xx) or deleted (refusal), all in the request transaction.
GRANT SELECT, INSERT, UPDATE, DELETE ON http_idempotency_keys TO app_user;
