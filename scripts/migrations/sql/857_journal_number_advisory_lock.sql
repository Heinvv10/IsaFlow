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
-- Lock key: pg_advisory_xact_lock(hashtextextended('<company_id>:<year>', 857)),
-- the single-bigint form every other per-company key here uses. The SEED 857
-- (this migration's number) is the namespace; no other key hashes this input
-- shape with this seed. A 64-bit hash makes a collision between two
-- company/year pairs (which would make two tenants wait on each other)
-- negligible — the 32-bit hashtext of round 1 measurably collided.
-- Released at COMMIT/ROLLBACK, and at ROLLBACK TO SAVEPOINT when taken inside
-- that savepoint.
--
-- What changes for waits (measured, not argued):
--   * Same company + year, two writers: the second waited before (on the first's
--     uncommitted index entry) and failed; it now waits and succeeds.
--   * A burst for one company + year now QUEUES instead of failing: writer k
--     waits for the k-1 transactions ahead of it, holding a pool connection the
--     whole time (before, all but one failed at once). This is the cost of not
--     failing.
--   * The wait is bounded ONLY by the caller's lock_timeout (55P03). The app pool
--     sets none (a pool-wide timeout was deferred 2026-10-02), so in production a
--     queued writer waits for as long as the transactions ahead of it run.
--   * The lock is a SUPERSET of the old wait, and it is taken EARLIER — in the
--     BEFORE INSERT trigger, before the row's pkey and
--     uq_gl_je_capture_source_document entries. Known residual (brk-jenum A3/A4/
--     A5), no in-app path today: (A3) a writer that numbers a journal and then
--     waits on another's uncommitted duplicate capture-source-document entry
--     now holds the number lock while it waits, so when that other transaction
--     next numbers a journal for the same company+year the pair deadlocks (40P01)
--     where the old code answered the duplicate 23505 — and the innocent writer
--     can be the victim; (A4) the same with an explicit duplicate journal id on
--     the pkey; (A5) after a committed draft is deleted the MAX falls, so the
--     old code minted a free number without waiting where this one waits on any
--     holder for that company+year. The capture posting routes claim the
--     document under FOR UPDATE first and createJournalEntry uses random ids, so
--     none of these is reachable from the app as it stands.
--
-- Also fixed in the re-created body: LPAD(next_seq, 5) TRUNCATED past 99999
-- (JE-<y>-100000 became JE-<y>-10000, then every insert failed 23505). The pad
-- width is now GREATEST(5, digits), so numbers keep all their digits; the MAX
-- casts the suffix to INT, so mixed 5- and 6-digit suffixes still order
-- numerically. entry_number is VARCHAR(50) (migration 500).
--
-- Unchanged: inserts that supply entry_number (the trigger's WHEN clause skips
-- the function: YE-<year>, DEP-..., imports), the owner, SECURITY INVOKER,
-- search_path and grants (CREATE OR REPLACE keeps owner and ACL). Only
-- REPEATABLE READ / SERIALIZABLE callers would still collide (their snapshot
-- predates the wait); no caller in this codebase uses them.
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
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.company_id::text || ':' || entry_year, 857));
  SELECT COALESCE(MAX(
    CAST(NULLIF(SPLIT_PART(entry_number, '-', 3), '') AS INT)
  ), 0) + 1 INTO next_seq
  FROM gl_journal_entries
  WHERE company_id = NEW.company_id
    AND entry_number LIKE 'JE-' || entry_year || '-%';
  NEW.entry_number := 'JE-' || entry_year || '-' || LPAD(next_seq::TEXT, GREATEST(5, LENGTH(next_seq::TEXT)), '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
