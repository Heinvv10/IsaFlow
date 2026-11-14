-- 992: The SharePoint archive copy of each filed proof of payment (POP inbox, phase 1 step 4).
--
-- WHAT.
--   pop_archive_targets  per company, the SharePoint site (Graph site id) and the folder under the site's
--     default document library that POP PDFs are copied into, as
--     <folder>/YYYY/MM/YYYY-MM-DD <beneficiary> R<amount> <transaction number>.pdf
--     (capture/pop/popArchiveName.ts). Ops config, like pop_trusted_payers (989): app sessions read it,
--     only migration_admin writes it. No row: that company's POPs are not archived.
--   pop_archive_copies  one row per POP once it is settled: 'archived' (the drive item's id, web URL and
--     path), 'too_large' (over Graph's 4 MB simple upload: never uploaded), or 'failed' (POP_ARCHIVE_MAX_ATTEMPTS
--     failed attempts; the last error is in pop_archive_attempts). A POP with a row is never uploaded again.
--     app_user (and app_service through it) SELECT + INSERT only: a settled copy is never edited.
--   pop_archive_attempts  one row per POP that failed at least once: `tries` (every failure), `attempts`
--     (failures that are this POP's own: no bytes, no path, Graph refused this file, an existing file that
--     differs; only these count toward 'failed'), when last, and why. A Graph outage (5xx, the network)
--     adds a try but no attempt, so it can never settle a good POP 'failed'. The sweep takes POPs never
--     tried first, then the least recently tried, and waits between tries (5 min doubling by `tries`, the
--     doubling capped at 2^8, about 21 h; the sweep stops counting `tries` at 1000), so a POP that keeps
--     failing never holds the batch.
--     app_user SELECT, INSERT of the first failure, UPDATE of the counters.
--   Ops: to retry 'failed' copies, as migration_admin delete their pop_archive_copies and pop_archive_attempts rows.
--
-- Credentials are not stored here: the Graph app's tenant, client id and secret are the
-- POP_ARCHIVE_* environment variables.
--
-- Tenancy: 989's forced-RLS policy verbatim. The POP is referenced with its company (991's
-- uq_proof_of_payments_id_company), so no session can claim another tenant's POP id.

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS pop_archive_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  site_id TEXT NOT NULL CHECK (btrim(site_id) <> '' AND length(site_id) <= 300),
  folder_path TEXT NOT NULL CHECK (btrim(folder_path, ' /') <> '' AND length(folder_path) <= 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE pop_archive_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE pop_archive_targets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON pop_archive_targets;
CREATE POLICY tenant_isolation ON pop_archive_targets FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
REVOKE INSERT, UPDATE, DELETE ON pop_archive_targets FROM app_user;
GRANT SELECT ON pop_archive_targets TO app_user;

CREATE TABLE IF NOT EXISTS pop_archive_copies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  proof_of_payment_id UUID NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('archived', 'too_large', 'failed')),
  drive_item_id TEXT CHECK (length(drive_item_id) <= 200),
  web_url TEXT CHECK (length(web_url) <= 2000),
  path TEXT CHECK (btrim(path) <> '' AND length(path) <= 1000),
  archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pop_archive_copies_one_per_pop UNIQUE (proof_of_payment_id),
  CONSTRAINT pop_archive_copies_pop_fkey FOREIGN KEY (proof_of_payment_id, company_id)
    REFERENCES proof_of_payments (id, company_id) ON DELETE CASCADE,
  CONSTRAINT pop_archive_copies_shape CHECK (
    (outcome = 'archived' AND drive_item_id IS NOT NULL AND path IS NOT NULL)
    OR (outcome = 'too_large' AND drive_item_id IS NULL AND path IS NOT NULL)
    OR (outcome = 'failed' AND drive_item_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_pop_archive_copies_company ON pop_archive_copies (company_id);

ALTER TABLE pop_archive_copies ENABLE ROW LEVEL SECURITY;
ALTER TABLE pop_archive_copies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON pop_archive_copies;
CREATE POLICY tenant_isolation ON pop_archive_copies FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
REVOKE INSERT, UPDATE, DELETE ON pop_archive_copies FROM app_user;
GRANT SELECT ON pop_archive_copies TO app_user;
GRANT INSERT (company_id, proof_of_payment_id, outcome, drive_item_id, web_url, path) ON pop_archive_copies TO app_user;

CREATE TABLE IF NOT EXISTS pop_archive_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  proof_of_payment_id UUID NOT NULL,
  attempts INT NOT NULL CHECK (attempts >= 0),
  tries INT NOT NULL DEFAULT 1 CHECK (tries > 0 AND tries >= attempts),
  last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT NOT NULL CHECK (length(last_error) <= 300),
  CONSTRAINT pop_archive_attempts_one_per_pop UNIQUE (proof_of_payment_id),
  CONSTRAINT pop_archive_attempts_pop_fkey FOREIGN KEY (proof_of_payment_id, company_id)
    REFERENCES proof_of_payments (id, company_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pop_archive_attempts_company ON pop_archive_attempts (company_id, last_attempt_at);

ALTER TABLE pop_archive_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pop_archive_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON pop_archive_attempts;
CREATE POLICY tenant_isolation ON pop_archive_attempts FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
REVOKE INSERT, UPDATE, DELETE ON pop_archive_attempts FROM app_user;
GRANT SELECT ON pop_archive_attempts TO app_user;
GRANT INSERT (company_id, proof_of_payment_id, attempts, last_error) ON pop_archive_attempts TO app_user;
GRANT UPDATE (attempts, tries, last_attempt_at, last_error) ON pop_archive_attempts TO app_user;

SELECT public.app_service_sync_policies();
