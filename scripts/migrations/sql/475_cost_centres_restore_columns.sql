-- Migration 475: Restore cost_centres dimension columns
--
-- Migration 285 added cc_type + department to cost_centres, but the live
-- schema is missing both — and `description` was never in any prior
-- migration even though costCentreService.ts has been reading and writing
-- it for some time. The result: GET /api/accounting/cost-centres?cc_type=…
-- returns 500 because `cc_type` doesn't exist; create/update calls would
-- 500 the moment they tried to write `description` or `department`.
--
-- Idempotent column-adds. Safe to re-run. Defaults match service mapRow's
-- fallback so existing rows pick up the new columns transparently.

ALTER TABLE cost_centres
  ADD COLUMN IF NOT EXISTS cc_type     VARCHAR(10) DEFAULT 'cc1',
  ADD COLUMN IF NOT EXISTS department  VARCHAR(100),
  ADD COLUMN IF NOT EXISTS description TEXT;

UPDATE cost_centres SET cc_type = 'cc1' WHERE cc_type IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_cost_centres_company_type_code
  ON cost_centres(company_id, cc_type, code);
