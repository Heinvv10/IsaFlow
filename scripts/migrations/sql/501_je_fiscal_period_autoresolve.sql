-- 501: auto-resolve gl_journal_entries.fiscal_period_id on INSERT
--
-- P2.2 (A–Z programme, audit W5): the balance cache and every period report
-- key on fiscal_period_id, but six writers INSERT journal entries directly
-- without resolving it (expense claims, depreciation hook, year-end, Sage
-- import, GL import, migration import) — their entries are invisible to
-- period reports while still in the TB. Britech's R267,109.70 salary
-- understatement (5 NULL-period journals) is this exact hole; prod carries
-- 200+ more such rows (mostly Demo: auto_expense_claim, auto_depreciation).
--
-- Fix at the choke point: a BEFORE INSERT trigger fills a NULL
-- fiscal_period_id from the period covering entry_date, mirroring createJournalEntry's
-- app-side lookup (with a deterministic ORDER BY the app code lacked until
-- this PR added it).
-- Rows with no covering period stay NULL — the integrity-check invariant
-- ("Posted JE fiscal period matches entry date") reports them for operator
-- action instead of silently misfiling them.
--
-- Historical backfill is deliberately NOT done here: repairs to real client
-- books (Britech) are HUMAN-GATED. Use
-- scripts/fixes/backfill-je-fiscal-periods.ts (dry-run default, per-company
-- scoping) after sign-off.

CREATE OR REPLACE FUNCTION resolve_je_fiscal_period()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.fiscal_period_id IS NULL THEN
    SELECT fp.id INTO NEW.fiscal_period_id
    FROM fiscal_periods fp
    WHERE fp.company_id = NEW.company_id
      AND NEW.entry_date BETWEEN fp.start_date AND fp.end_date
    ORDER BY fp.start_date
    LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_gl_je_fiscal_period ON gl_journal_entries;
CREATE TRIGGER trg_gl_je_fiscal_period
  BEFORE INSERT ON gl_journal_entries
  FOR EACH ROW
  WHEN (NEW.fiscal_period_id IS NULL)
  EXECUTE FUNCTION resolve_je_fiscal_period();
