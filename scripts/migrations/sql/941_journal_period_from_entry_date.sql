-- 941: A journal's fiscal period is derived from its entry_date
-- (change-of-year-end programme, Feature A).
--
-- WHY. gl_journal_entries.fiscal_period_id was set once, at INSERT, and only
-- when NULL (migration 501). Nothing checked an explicit value, and nothing
-- re-resolved it when entry_date changed, so the period a journal reported in
-- could disagree with its date. It is now a checked cache of "the period whose
-- range holds entry_date":
--
--   INSERT  NULL is filled from entry_date (501's behaviour); an explicit id
--           must be that period, else 23514. A date no period covers stays
--           NULL, reported by the integrity check as before.
--   UPDATE  only when entry_date or fiscal_period_id changes, so existing rows
--           never block an unrelated update. A new entry_date re-derives the
--           period (a non-draft entry may not move to a date no period covers);
--           an explicit new id must hold entry_date.
--
-- Measured on isaflow_dev before writing (2026-10-23): 0 journals whose stored
-- period does not hold their date, 0 cross-company, 21 NULL with no covering
-- period. Nothing is corrected here (gate G3).
--
-- The balance cache (gl_account_balances, keyed by period) now follows a
-- re-pointed posted journal: migration 499's trigger also fires when
-- fiscal_period_id changes on a posted entry, and it already recomputes both
-- the old and the new period. It is a plain AFTER UPDATE with a WHEN, not
-- UPDATE OF fiscal_period_id: a column list only sees columns in the SET list,
-- and a new entry_date moves the period through the BEFORE trigger above.

CREATE OR REPLACE FUNCTION public.gl_je_fiscal_period_from_date()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  covering uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.entry_date IS NOT DISTINCT FROM OLD.entry_date
     AND NEW.fiscal_period_id IS NOT DISTINCT FROM OLD.fiscal_period_id
     AND NEW.company_id IS NOT DISTINCT FROM OLD.company_id THEN
    RETURN NEW;
  END IF;

  SELECT fp.id INTO covering FROM fiscal_periods fp
   WHERE fp.company_id = NEW.company_id AND NEW.entry_date BETWEEN fp.start_date AND fp.end_date
   ORDER BY fp.start_date
   LIMIT 1;

  -- A journal that is not a draft never moves out of every period: re-dating a
  -- posted entry to a date no period covers would drop it from every period
  -- report (integrity check #9 would then fail the deploy gate).
  IF TG_OP = 'UPDATE' AND covering IS NULL AND COALESCE(NEW.status, 'draft') <> 'draft'
     AND NEW.entry_date IS DISTINCT FROM OLD.entry_date THEN
    RAISE EXCEPTION 'journal entry % (%): no fiscal period covers the new entry_date %; create that period first',
      NEW.id, NEW.status, NEW.entry_date USING ERRCODE = '23514';
  END IF;
  -- Nor into, or out of, a period that is not open (its balance cache is sealed).
  IF TG_OP = 'UPDATE' AND COALESCE(NEW.status, 'draft') <> 'draft'
     AND covering IS DISTINCT FROM OLD.fiscal_period_id
     AND EXISTS (SELECT 1 FROM fiscal_periods fp WHERE fp.id IN (covering, OLD.fiscal_period_id) AND fp.status <> 'open') THEN
    RAISE EXCEPTION 'journal entry % (%): moving it to % would move it into or out of a period that is not open',
      NEW.id, NEW.status, NEW.entry_date USING ERRCODE = '55000';
  END IF;
  IF NEW.fiscal_period_id IS NULL
     OR (TG_OP = 'UPDATE' AND NEW.fiscal_period_id IS NOT DISTINCT FROM OLD.fiscal_period_id) THEN
    NEW.fiscal_period_id := covering;
    RETURN NEW;
  END IF;

  IF covering IS DISTINCT FROM NEW.fiscal_period_id THEN
    RAISE EXCEPTION 'journal entry % dated %: fiscal_period_id % is not the period that holds that date (%)',
      NEW.id, NEW.entry_date, NEW.fiscal_period_id, COALESCE(covering::text, 'none')
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_gl_je_fiscal_period ON gl_journal_entries;
DROP TRIGGER IF EXISTS trg_gl_je_fiscal_period_from_date ON gl_journal_entries;
CREATE TRIGGER trg_gl_je_fiscal_period_from_date
  BEFORE INSERT OR UPDATE OF entry_date, fiscal_period_id, company_id ON gl_journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.gl_je_fiscal_period_from_date();
ALTER TABLE gl_journal_entries ENABLE ALWAYS TRIGGER trg_gl_je_fiscal_period_from_date;

-- 501's function has no trigger left.
DROP FUNCTION IF EXISTS public.resolve_je_fiscal_period();

DROP TRIGGER IF EXISTS trg_gl_je_status_balance ON gl_journal_entries;
CREATE TRIGGER trg_gl_je_status_balance
  AFTER UPDATE ON gl_journal_entries
  FOR EACH ROW
  WHEN (
    (OLD.status IS DISTINCT FROM NEW.status AND (OLD.status = 'posted' OR NEW.status = 'posted'))
    OR (NEW.status = 'posted' AND OLD.fiscal_period_id IS DISTINCT FROM NEW.fiscal_period_id)
  )
  EXECUTE FUNCTION refresh_gl_account_balances_on_status_change();
