-- BL-13: Add company_id to gl_journal_lines for multi-tenant scoping + partition pruning.
-- Also enables defense-in-depth against regressions like S-001 (now-fixed cross-tenant leak).

-- Phase 1: add nullable column
ALTER TABLE gl_journal_lines
  ADD COLUMN IF NOT EXISTS company_id UUID;

-- Phase 2: backfill from parent entry
UPDATE gl_journal_lines jl
SET company_id = je.company_id
FROM gl_journal_entries je
WHERE jl.journal_entry_id = je.id
  AND jl.company_id IS NULL;

-- Phase 3: enforce NOT NULL (requires Phase 2 to cover every row)
ALTER TABLE gl_journal_lines
  ALTER COLUMN company_id SET NOT NULL;

-- Phase 4: foreign key
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_gl_journal_lines_company') THEN
    ALTER TABLE gl_journal_lines
      ADD CONSTRAINT fk_gl_journal_lines_company
      FOREIGN KEY (company_id) REFERENCES companies(id);
  END IF;
END $$;

-- Phase 5: indexes for partition pruning / perf
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gl_jl_company_entry
  ON gl_journal_lines (company_id, journal_entry_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gl_jl_company_account
  ON gl_journal_lines (company_id, gl_account_id);
