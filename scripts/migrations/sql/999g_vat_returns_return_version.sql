-- 999g: vat_returns.return_version_id, the VAT201 version a settlement was posted against (wave 6 VR, §0a.12).
--
-- WHAT. The return lifecycle (tax_return_versions, 969/971) is the record of a VAT201; vat_returns is the settlement
-- record (submitVATReturn's clearing journal). From this release submitVATReturn refuses a period with no finalised or
-- filed VAT201 version and writes the version it settled here. After an amend, the next version may be settled by a
-- TOP-UP (only the difference from what the period already settled), so a period can hold one settlement per version.
--   return_version_id  UUID NULL. NULL = settled before the lifecycle (or by the old colour of a deploy).
--   vat_returns_return_version_fk  (company_id, return_version_id, period_start, period_end)
--                      -> tax_return_versions (company_id, id, period_start, period_end): a settlement can name only a
--                      version of its own company AND its own period (a plain FK on id would accept another tenant's,
--                      as 969 says of its own references). MATCH SIMPLE: a NULL return_version_id is not checked.
--                      Added NOT VALID, backfilled, then VALIDATEd in this file (spec rule 13).
--   uq_tax_return_versions_company_period_id  the unique key that FK needs; id is the primary key, so it is unique by
--                      construction.
--   uq_vat_returns_period_settlement  replaces UNIQUE (company_id, period_start, period_end): one settlement per
--                      (company, period, version), and still exactly one per (company, period) among the rows with no
--                      version (COALESCE to the nil uuid), which are the only rows the old colour writes. So every
--                      guarantee the old colour relied on still holds for its rows; only new-code rows, each naming a
--                      different version, may share a period. The new index is built before the old constraint goes,
--                      in this one transaction.
--
-- BACKFILL. A row is linked to the non-superseded VAT201 version of the same company and EXACT period only when that
-- version was finalised at or before the settlement (finalised_at <= submitted_at) and no version of the period was
-- superseded after the settlement (the version it would name was already the live one when it was settled). Anything
-- else stays NULL: a legacy settlement is never claimed for a version finalised after it. Deterministic (at most one
-- non-superseded version per period, uq_tax_return_versions_one_current). Dev (2026-11-16, read-only): 18 rows, 0
-- with a version.
--
-- OLD COLOUR (the release before this one, while the deploy switches colours, or after a code-only rollback):
--   insert  submitVATReturn names its columns and leaves return_version_id out: NULL, allowed; the FK skips NULL. Its
--           idempotency read ("a submitted row for the period exists") still refuses a second settlement, and the new
--           unique index still refuses a second NULL row for the period, as the old constraint did.
--   update  the old code never updates vat_returns.
--   read    SELECT * returns one more column; mapRow names the columns it reads.
--   tax_return_versions  the old code inserts versions with gen_random_uuid ids: the new unique index on
--           (company_id, id, period_start, period_end) cannot fire for a fresh id. It never deletes one (969's trigger).
--
-- LOCKS. Every lock below is held until this file's transaction commits, not only for its statement.
--   vat_returns          ACCESS EXCLUSIVE from the first statement (ADD COLUMN; DROP CONSTRAINT takes it again): no
--                        read or write of vat_returns proceeds until commit.
--   tax_return_versions  SHARE (the unique index build) + SHARE ROW EXCLUSIVE (the FK): reads proceed, every write
--                        (finalise, file, amend) waits until commit.
-- The backfill and VALIDATE run under those locks. Timed on a throwaway PG16 cluster with 240,000 settlements, each
-- with a version (the PR body has the figure); real tables are small (dev: 24 VAT201 versions, 18 settlements).
-- lock_timeout bounds the wait to acquire them, statement_timeout each statement.
--
-- Rollback: ALTER TABLE vat_returns DROP CONSTRAINT IF EXISTS vat_returns_return_version_fk;
--           (only while no period holds two rows) ALTER TABLE vat_returns
--             ADD CONSTRAINT vat_returns_company_id_period_start_period_end_key UNIQUE (company_id, period_start, period_end);
--           DROP INDEX IF EXISTS uq_vat_returns_period_settlement;
--           ALTER TABLE vat_returns DROP COLUMN IF EXISTS return_version_id;
--           DROP INDEX IF EXISTS uq_tax_return_versions_company_period_id;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE vat_returns ADD COLUMN IF NOT EXISTS return_version_id UUID NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_tax_return_versions_company_period_id
  ON tax_return_versions (company_id, id, period_start, period_end);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'vat_returns_return_version_fk' AND conrelid = 'public.vat_returns'::regclass
  ) THEN
    ALTER TABLE vat_returns
      ADD CONSTRAINT vat_returns_return_version_fk
      FOREIGN KEY (company_id, return_version_id, period_start, period_end)
      REFERENCES tax_return_versions (company_id, id, period_start, period_end) NOT VALID;
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
   AND vr.submitted_at IS NOT NULL
   AND v.finalised_at <= vr.submitted_at
   AND NOT EXISTS (
     SELECT 1 FROM tax_return_versions o
      WHERE o.company_id = vr.company_id AND o.form_type = 'VAT201'
        AND o.period_start = vr.period_start AND o.period_end = vr.period_end
        AND o.amended_at IS NOT NULL AND o.amended_at > vr.submitted_at);

ALTER TABLE vat_returns VALIDATE CONSTRAINT vat_returns_return_version_fk;

CREATE UNIQUE INDEX IF NOT EXISTS uq_vat_returns_period_settlement
  ON vat_returns (company_id, period_start, period_end,
                  COALESCE(return_version_id, '00000000-0000-0000-0000-000000000000'::UUID));

ALTER TABLE vat_returns DROP CONSTRAINT IF EXISTS vat_returns_company_id_period_start_period_end_key;

COMMENT ON COLUMN vat_returns.return_version_id IS
  'Wave 6 VR (2026-11-16): the VAT201 tax_return_versions row this settlement was posted against (same company and period). NULL = settled before the return lifecycle.';
