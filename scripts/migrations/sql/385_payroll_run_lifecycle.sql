-- 385_payroll_run_lifecycle.sql
-- PRD-02 Phase 3: add lifecycle audit columns to payroll_run_headers so we
-- know WHO approved/paid/cancelled WHEN, and which GL journal entry was
-- posted on approval.

ALTER TABLE payroll_run_headers
  ADD COLUMN IF NOT EXISTS approved_by                UUID,
  ADD COLUMN IF NOT EXISTS approved_at                TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paid_at                    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by               UUID,
  ADD COLUMN IF NOT EXISTS cancelled_at               TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS posted_journal_entry_id    UUID;

-- FK to gl_journal_entries (guarded in case the table isn't present yet)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'gl_journal_entries')
     AND NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                     WHERE table_name = 'payroll_run_headers'
                       AND constraint_name = 'payroll_run_headers_posted_je_fkey')
  THEN
    ALTER TABLE payroll_run_headers
      ADD CONSTRAINT payroll_run_headers_posted_je_fkey
      FOREIGN KEY (posted_journal_entry_id)
      REFERENCES gl_journal_entries(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_payroll_run_headers_posted_je
  ON payroll_run_headers (posted_journal_entry_id)
  WHERE posted_journal_entry_id IS NOT NULL;
