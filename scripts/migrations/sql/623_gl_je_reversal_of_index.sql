-- 623: index the reversal link the VAT201 cancelled-document CTE probes.
-- `vatBoxBasisQuery` pairs a cancelled document's journal with its reversal via
-- gl_journal_entries.reversal_of_id. Without an index the planner scans the
-- tenant's whole journal history on every VAT201 render. Partial: reversals are
-- a small minority of rows.
CREATE INDEX IF NOT EXISTS idx_gl_je_reversal_of
  ON gl_journal_entries(reversal_of_id)
  WHERE reversal_of_id IS NOT NULL;
