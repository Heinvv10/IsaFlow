-- 408_company_entity_type_backfill.sql
-- Backfill legacy entity_type values and install the CHECK constraint that
-- migration 407 was supposed to add.
--
-- Why: 407 used ADD COLUMN IF NOT EXISTS on entity_type, but the column
-- already existed on companies with legacy values ('company', etc.). The
-- IF NOT EXISTS made the ALTER a no-op, so the CHECK (pty|cc|trust) was
-- never installed and Phase 8 multi-entity logic fell through to the pty
-- fallback in getCompanyTerminology for every tenant.

-- 1. Normalise legacy values.
UPDATE companies SET entity_type = 'pty'
  WHERE entity_type IS NULL OR entity_type NOT IN ('pty', 'cc', 'trust');

-- 2. Install the constraint — drop-then-add so re-running is idempotent
--    and so we don't trip over a partial CHECK from a prior attempt.
ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_entity_type_check;
ALTER TABLE companies
  ADD CONSTRAINT companies_entity_type_check
  CHECK (entity_type IN ('pty', 'cc', 'trust'));

-- 3. Default for new rows (407 set this but IF NOT EXISTS skipped it).
ALTER TABLE companies ALTER COLUMN entity_type SET DEFAULT 'pty';
