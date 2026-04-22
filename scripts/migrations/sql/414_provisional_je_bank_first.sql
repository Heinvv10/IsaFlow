-- PRD-05 Phase 5: Bank-first inverted workflow.
--
-- When a bank transaction lands without a matching invoice, the system posts a
-- provisional JE immediately from historical supplier-coding patterns. Evidence
-- (slip/invoice) attaches later — flipping posting_agent from
-- 'ai-provisional:v1' → 'ai-evidenced:v1'. A chase job nudges the user after
-- N days when a provisional is still unevidenced.

-- ── Provisional JE flags on gl_journal_entries ──────────────────────────────

ALTER TABLE gl_journal_entries
  ADD COLUMN IF NOT EXISTS needs_evidence BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS evidenced_at   TIMESTAMPTZ;

-- Partial index for the chase job: fast lookup of old unevidenced JEs.
CREATE INDEX IF NOT EXISTS idx_gl_je_needs_evidence
  ON gl_journal_entries(entry_date)
  WHERE needs_evidence = TRUE;

-- ── Link bank_transactions back to their provisional JE ─────────────────────

ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS provisional_je_id   UUID REFERENCES gl_journal_entries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS predicted_supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS prediction_confidence NUMERIC(5,4);

CREATE INDEX IF NOT EXISTS idx_bt_provisional_je
  ON bank_transactions(provisional_je_id)
  WHERE provisional_je_id IS NOT NULL;

-- Extend the status CHECK constraint to allow 'provisional'. The existing
-- constraint is named implicitly; recreate it safely.
DO $$
DECLARE
  cname TEXT;
BEGIN
  SELECT con.conname INTO cname
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'bank_transactions'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) LIKE '%status%';

  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE bank_transactions DROP CONSTRAINT %I', cname);
  END IF;

  ALTER TABLE bank_transactions
    ADD CONSTRAINT bank_transactions_status_check
    CHECK (status IN ('imported', 'provisional', 'matched', 'reconciled', 'excluded'));
END
$$;
