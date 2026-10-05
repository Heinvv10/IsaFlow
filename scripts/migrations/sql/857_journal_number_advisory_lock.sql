-- Migration 857: journal numbers no longer collide under concurrent posting.
-- 2026-10-05 | fix/je-number-advisory-lock-20261005
--
-- generate_journal_entry_number() (BEFORE INSERT trigger trg_gl_je_entry_number,
-- last defined in migration 220) mints `JE-<year>-<seq>` as MAX(seq)+1 over the
-- company's committed numbers for that year, with nothing serialising two
-- writers. Two transactions numbering a journal for the same company and year
-- both read the same MAX and mint the same number; the second blocks on
-- uq_gl_je_company_entry_number until the first commits and then fails 23505.
-- A handful of routes map that to a retryable answer; every other caller
-- answered a raw 23505 (a 400 naming the constraint, or a 500).
--
-- The fix: before reading MAX, the trigger takes a transaction-scoped advisory
-- lock on (company, year). The second writer now waits for the first to COMMIT
-- (or roll back), and its MAX — read by a later statement under READ COMMITTED,
-- so with a fresh snapshot — sees the first writer's number and mints the next.
--
-- Lock key: the TWO-int4 form, pg_advisory_xact_lock(857, hashtext('<company_id>:<year>')).
--   * Namespace 857 (this migration's number) is the first argument. Every other
--     advisory lock in this codebase uses the single-bigint form, which Postgres
--     keeps in a separate key space (pg_locks.objsubid 1 vs 2), so no existing
--     key can collide with this one. A hashtext collision between two
--     company/year pairs only serialises them; it cannot mint a wrong number.
--   * Released at COMMIT/ROLLBACK, and at ROLLBACK TO SAVEPOINT when it was
--     taken inside that savepoint — the same lifetime as the unique-index entry
--     the second writer waited on before this change.
--
-- No new wait and no new lock-order edge: the second writer already waited on
-- the first writer's uncommitted index entry (for exactly the same pair of
-- transactions) and then failed; it now waits on this lock instead and
-- succeeds. The wait is bounded by the caller's lock_timeout exactly as that
-- index wait was (55P03).
--
-- Unchanged: inserts that supply entry_number (the trigger's WHEN clause skips
-- the function: YE-<year>, DEP-..., imports), the number format, the owner,
-- SECURITY INVOKER, search_path and grants (CREATE OR REPLACE keeps owner and
-- ACL). Only REPEATABLE READ / SERIALIZABLE callers would still collide (their
-- snapshot predates the wait); no caller in this codebase uses them.
--
-- Idempotent: CREATE OR REPLACE of the same body.

CREATE OR REPLACE FUNCTION generate_journal_entry_number()
RETURNS TRIGGER AS $$
DECLARE
  entry_year INT;
  next_seq INT;
BEGIN
  IF NEW.entry_number IS NOT NULL THEN
    RETURN NEW;
  END IF;
  entry_year := EXTRACT(YEAR FROM COALESCE(NEW.entry_date, CURRENT_DATE));
  PERFORM pg_advisory_xact_lock(857, hashtext(NEW.company_id::text || ':' || entry_year));
  SELECT COALESCE(MAX(
    CAST(NULLIF(SPLIT_PART(entry_number, '-', 3), '') AS INT)
  ), 0) + 1 INTO next_seq
  FROM gl_journal_entries
  WHERE company_id = NEW.company_id
    AND entry_number LIKE 'JE-' || entry_year || '-%';
  NEW.entry_number := 'JE-' || entry_year || '-' || LPAD(next_seq::TEXT, 5, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
