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
-- Cross-year bulk posting (brk-docnum F3): a run that posts journals dated in
-- two or more years takes ('<company_id>:<year>', 857) for EVERY year, in
-- ascending order, before its first journal (core/numberYearLocks.ts). Two such
-- runs in opposite year order deadlocked (40P01) on the journal key itself.
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
