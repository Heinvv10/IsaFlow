-- 999d: vat_returns.return_version_id, the VAT201 version a settlement was posted against (wave 6 VR, §0a.12).
--
-- WHAT. The return lifecycle (tax_return_versions, 969/971) is the record of a VAT201; vat_returns is the settlement
-- record (submitVATReturn's clearing journal). From this release submitVATReturn refuses a period with no finalised or
-- filed VAT201 version and writes the version it settled here.
--   return_version_id  UUID NULL. Legacy rows (settled before the lifecycle) keep NULL unless the backfill below finds
--                      their version.
--   vat_returns_return_version_fk  (company_id, return_version_id) -> tax_return_versions (company_id, id): the
--                      composite key makes another tenant's version id impossible, which a plain FK on id would accept
--                      (969 says the same of its own references). MATCH SIMPLE: a NULL return_version_id is not checked.
--                      Added NOT VALID, backfilled, then VALIDATEd in this file (spec rule 13).
--   uq_tax_return_versions_company_id  the unique key the composite FK needs. id is already the primary key, so
--                      (company_id, id) is unique by construction; the index only lets the FK name it.
--
-- BACKFILL. A row is linked to the one non-superseded VAT201 version of the same company and EXACT period, only when
-- exactly one exists (uq_tax_return_versions_one_current allows at most one, so "exactly one" is "one"). Anything else
-- stays NULL. Deterministic: no ordering is consulted. Dev (2026-11-16, read-only): 18 rows, 0 with a version.
--
-- OLD COLOUR (the release before this one, while the deploy switches colours, or after a code-only rollback):
--   insert  submitVATReturn names its columns and leaves return_version_id out: NULL, allowed; the FK skips NULL.
--   update  the old code never updates vat_returns.
--   read    SELECT * returns one more column; mapRow names the columns it reads.
--   tax_return_versions  the old code inserts versions with gen_random_uuid ids: the new unique index on
--           (company_id, id) cannot fire for a fresh id. It never deletes a version (969's trigger refuses it).
--
-- LOCKS. ADD COLUMN without a default is catalogue-only. The index build takes SHARE on tax_return_versions and the
-- FK SHARE ROW EXCLUSIVE on both tables: small tables (dev: 24 VAT201 versions, 18 settlements), bounded by
-- lock_timeout.
--
-- Rollback: ALTER TABLE vat_returns DROP CONSTRAINT IF EXISTS vat_returns_return_version_fk;
--           ALTER TABLE vat_returns DROP COLUMN IF EXISTS return_version_id;
--           DROP INDEX IF EXISTS uq_tax_return_versions_company_id;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE vat_returns ADD COLUMN IF NOT EXISTS return_version_id UUID NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_tax_return_versions_company_id ON tax_return_versions (company_id, id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'vat_returns_return_version_fk' AND conrelid = 'public.vat_returns'::regclass
  ) THEN
    ALTER TABLE vat_returns
      ADD CONSTRAINT vat_returns_return_version_fk
      FOREIGN KEY (company_id, return_version_id) REFERENCES tax_return_versions (company_id, id) NOT VALID;
  END IF;
END $$;

UPDATE vat_returns vr
   SET return_version_id = v.id
  FROM tax_return_versions v
 WHERE vr.return_version_id IS NULL
   AND v.company_id = vr.company_id
   AND v.form_type = 'VAT201'
   AND v.status <> 'superseded'
   AND v.period_start = vr.period_start
   AND v.period_end = vr.period_end
   AND (SELECT COUNT(*) FROM tax_return_versions o
         WHERE o.company_id = vr.company_id AND o.form_type = 'VAT201' AND o.status <> 'superseded'
           AND o.period_start = vr.period_start AND o.period_end = vr.period_end) = 1;

ALTER TABLE vat_returns VALIDATE CONSTRAINT vat_returns_return_version_fk;

COMMENT ON COLUMN vat_returns.return_version_id IS
  'Wave 6 VR (2026-11-16): the VAT201 tax_return_versions row this settlement was posted against. NULL = settled before the return lifecycle.';
