-- 992: The SharePoint archive copy of each filed proof of payment (POP inbox, phase 1 step 4).
--
-- WHAT.
--   pop_archive_targets  per company, the SharePoint site (Graph site id) and the folder under the site's
--     default document library that POP PDFs are copied into, as
--     <folder>/YYYY/MM/YYYY-MM-DD <beneficiary> R<amount> <transaction number>.pdf
--     (capture/pop/popArchiveName.ts). Ops config, like pop_trusted_payers (989): app sessions read it,
--     only migration_admin writes it. No row: that company's POPs are not archived.
--   pop_archive_copies  one row per POP once it was copied (outcome 'archived': the drive item's id,
--     web URL and path), or once it was found too large for a simple upload (outcome 'too_large', over
--     4 MB: never retried). A POP with a row is never uploaded again. Written by the mirror cron
--     (capture/pop/popArchiveSweep.ts): app_user (and app_service through it) SELECT + INSERT only.
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
  outcome TEXT NOT NULL CHECK (outcome IN ('archived', 'too_large')),
  drive_item_id TEXT CHECK (length(drive_item_id) <= 200),
  web_url TEXT CHECK (length(web_url) <= 2000),
  path TEXT NOT NULL CHECK (btrim(path) <> '' AND length(path) <= 1000),
  archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pop_archive_copies_one_per_pop UNIQUE (proof_of_payment_id),
  CONSTRAINT pop_archive_copies_pop_fkey FOREIGN KEY (proof_of_payment_id, company_id)
    REFERENCES proof_of_payments (id, company_id) ON DELETE CASCADE,
  CONSTRAINT pop_archive_copies_shape CHECK (outcome = 'too_large' OR drive_item_id IS NOT NULL)
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

SELECT public.app_service_sync_policies();
