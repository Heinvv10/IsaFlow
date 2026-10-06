-- Migration 864: one bounded number lock for app-side document numbers and for
-- cross-year bulk posting.
-- 2026-10-06 | fix/numrace-20261006
--
-- public.take_number_lock(p_scope, p_seed) takes
-- pg_advisory_xact_lock(hashtextextended(p_scope, p_seed)), with exactly the
-- wait bound of migration 858: read current_setting('lock_timeout'), set the
-- transaction-local value to 5 s only when the caller's is 0 (unbounded) or
-- longer, take the lock, put the caller's value back. A caller with a tighter
-- value keeps it (tighten-only). On a 55P03 the (sub)transaction aborts and its
-- rollback restores the caller's value too. No function-level SET clause: that
-- REPLACES a tighter caller value for the call (sec-docnum N1). SECURITY
-- INVOKER; released at COMMIT / ROLLBACK, or at ROLLBACK TO SAVEPOINT when
-- taken inside that savepoint.
--
-- WHY. App-side numbers were minted as MAX(seq)+1 with nothing serialising
-- two writers: both read the same MAX, the second blocked on the unique index
-- until the first committed and then failed 23505 (a 500). The caller now takes
-- this lock on the number's scope BEFORE its MAX read, inside the request
-- transaction; the second writer waits (at most 5 s, then 55P03 -> 503 +
-- Retry-After) and its MAX — a later statement under READ COMMITTED — sees the
-- first number.
--
-- THE KEYS (scope, seed). A number minted in a transaction that also posts a
-- journal shares 857's journal key — one key, not one per type, because a
-- per-type key against the journal key deadlocked (858, measured):
--
--   number                     scope                          seed
--   asset <PFX>-NNNN           '<company_id>:<PFX>'           864001
--   PROJ-NNNN                  '<company_id>'                 864002
--   CL-YYYY-NNNN (claim)       '<company_id>:<YYYY>'          864003
--   ITEM-NNNN                  '<company_id>'                 864004
--   INV-YYYYMM-NNNN (admin)    'INV-YYYYMM-' (platform-wide)  864005
--
-- Cross-year bulk posting (brk-docnum F3): two runs posting journals of two
-- years in opposite order deadlocked (40P01) on 857's journal key itself.
-- DECIDED, changed 2026-10-06 (Hein, on brk-numrace N1 evidence): ORDERED
-- LAZY, not "every year's key up front" (core/numberYearLocks.ts). A run walks
-- its elements by (min predicted year, its own order), so it reaches its keys
-- ascending. A single-year element takes no key early: its posting takes it
-- after the element's own row locks, exactly where base takes it — so a single
-- writer of one of its rows (row, then number) is waited for, never cycled
-- with. Before a multi-year element (late-claim companion, VAT-roll reversal,
-- provisional reclass) the run takes every year from its min to its max not
-- yet taken, ascending; the held set at or above the current min stays one
-- contiguous range, so every acquisition is ascending. Predicted sets are
-- supersets on the low side. A run whose predicted years (multi-year ranges
-- filled) exceed 20 is refused before any lock or write (400): each key is an
-- entry in the cluster-wide shared lock table, and one run naming thousands of
-- years exhausted it (sec-numrace S1). Rounds 1-2 took every key up front and
-- then the rows: that cycled with single writers on any lock but the first.
--
-- Not covered: TXF- bank-transfer numbers. That route fails on every call
-- before it numbers anything (it inserts gl_journal_entries columns that do not
-- exist) and is reported as its own defect; when it is repaired its number
-- belongs under 857's key, '<company_id>:<year>', since it IS the journal.
--
-- Residuals:
--   * A burst for one scope queues, each writer holding its pool connection for
--     up to 5 s; a bulk run spanning years holds every year's key to its end,
--     so other posts for those years 503 after 5 s (DOCNUM register (d)).
--   * A multi-year element takes its range before its rows, so against a single
--     writer of THAT element's row which then numbers inside the range it can
--     still cycle (both sides retryable); and after one, the rest of the run's
--     elements hold its keys while they lock their rows.
--   * bank-transactions-bulk-commit (sweep, then rule pass, one transaction)
--     claims the existing rule candidates' bank lines first, then takes every
--     statement + candidate year up front (bank/bulkCommitRulePass); what a rule
--     line locks after its row it locks after those keys, as on base.
--   * READ COMMITTED only, as 857/858.
--
-- Idempotent: CREATE OR REPLACE of the same body.

CREATE OR REPLACE FUNCTION public.take_number_lock(p_scope text, p_seed bigint)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  prev_lock_timeout TEXT;
BEGIN
  -- Bound the wait at 5 s, never loosen a caller's tighter bound (0 = unbounded).
  prev_lock_timeout := current_setting('lock_timeout');
  IF prev_lock_timeout::interval = interval '0' OR prev_lock_timeout::interval > interval '5s' THEN
    PERFORM set_config('lock_timeout', '5s', true);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_scope, p_seed));
  PERFORM set_config('lock_timeout', prev_lock_timeout, true);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.take_number_lock(text, bigint) TO app_user;
