-- 852_gateway_fee_journal_unique.sql
-- R-185: one live Paystack fee journal per (company, reference).
--
-- postGatewayFee (gatewayFeeService.ts) guarded the fee leg with a SELECT and
-- then inserted. Two dedupe-path deliveries for one reference (two webhook
-- bodies, or verify and the webhook, arriving together after the receipt was
-- banked) could both pass the SELECT and both post the fee: the expense
-- doubled and Bank fell short of the deposit by the fee. This index makes the
-- second insert raise 23505; postGatewayFee runs its create+post in a
-- savepoint and, on any failure, re-reads by outcome.
--
-- The predicate is the guard's own, so the two can never disagree:
--   * posting_agent 'system:paystack-receipt:v1' with a reference: only the fee
--     journal. The receipt journal carries the same agent but confirmCustomerPayment
--     passes no reference, so its reference is NULL and it is outside the index.
--   * status IS DISTINCT FROM 'reversed': status is nullable varchar
--     (draft | posted | reversed). A reversal does not flip the original's
--     status (it stays 'posted', reversed_at is stamped), so a reversed fee
--     journal still occupies its reference here, as it does in the guard. Its
--     contra is created with no reference, so it never collides.
--
-- Census (read-only; run on dev and prod BEFORE applying; must be 0 rows):
--
--   SELECT company_id, reference, count(*) AS n, array_agg(id ORDER BY created_at) AS ids
--   FROM gl_journal_entries
--   WHERE posting_agent = 'system:paystack-receipt:v1'
--     AND reference IS NOT NULL
--     AND status IS DISTINCT FROM 'reversed'
--   GROUP BY company_id, reference
--   HAVING count(*) > 1;
--
-- Existing duplicates are NOT repaired here (a ledger correction is Hein's call):
-- the DO block below refuses with the count, before the index is attempted.
--
-- Two separate risks, two bounds. The build takes a SHARE lock on
-- gl_journal_entries, which blocks every journal write:
--   * lock_timeout bounds only the WAIT for that lock: queued behind a long
--     transaction, the build would hold every later writer behind it too.
--   * statement_timeout bounds how long the build (and the census scan in the DO
--     block) may then run while it HOLDS the lock: a full scan of the table.
-- Either one firing cancels the statement and the runner rolls the whole file
-- back (no half-built index). The prod row count was not measured from here; if
-- 120s is not enough, 852 fails cleanly and needs a quieter window or a CONCURRENTLY
-- build outside the runner's transaction, not a larger number by default.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $$
DECLARE
  dup_groups INTEGER;
BEGIN
  SELECT count(*) INTO dup_groups FROM (
    SELECT 1
    FROM gl_journal_entries
    WHERE posting_agent = 'system:paystack-receipt:v1'
      AND reference IS NOT NULL
      AND status IS DISTINCT FROM 'reversed'
    GROUP BY company_id, reference
    HAVING count(*) > 1
  ) d;
  IF dup_groups > 0 THEN
    RAISE EXCEPTION 'R-185: % (company_id, reference) group(s) already hold more than one live Paystack fee journal; run the census in the header of 852_gateway_fee_journal_unique.sql and repair them first', dup_groups;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_gl_je_gateway_fee_reference
  ON gl_journal_entries (company_id, reference)
  WHERE posting_agent = 'system:paystack-receipt:v1'
    AND reference IS NOT NULL
    AND status IS DISTINCT FROM 'reversed';
