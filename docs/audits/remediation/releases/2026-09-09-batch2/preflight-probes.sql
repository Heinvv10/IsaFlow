-- Deploy preflight probe SQL, extracted from fixer fix.md files.
-- All statements are read-only SELECTs. Run each against production BEFORE
-- applying the named migration.

-- ============================================================
-- Migration 619 (K-010) — ux_gl_je_reversal_of unique index
-- Source: fix-K-010/docs/audits/remediation/K-010/fix.md
-- ============================================================

-- Probe 1a: duplicate contras per original journal entry. Any row returned
-- means the migration's own duplicate check will refuse to apply; repair
-- before deploying.
SELECT count(*) FROM (
  SELECT e.company_id, e.reversal_of_id, count(*) AS contras
  FROM gl_journal_entries e
  WHERE e.reversal_of_id IS NOT NULL AND e.status = 'posted'
  GROUP BY 1, 2 HAVING count(*) > 1
) q;

-- Probe 1b: stuck-claim baseline — entries marked reversed with no contra
-- behind them. This CAN return pre-existing rows (a two-statement write
-- crash window in the old code). Take this count as a BASELINE before
-- deploying, then re-run afterwards on an ongoing basis; only rows appearing
-- AFTER deploy are a new regression.
SELECT count(*) FROM (
  SELECT e.company_id, e.id, e.entry_number, e.reversed_at, e.reversed_by
  FROM gl_journal_entries e
  WHERE e.reversed_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM gl_journal_entries c
                    WHERE c.company_id = e.company_id AND c.reversal_of_id = e.id)
) q;

-- ============================================================
-- Migration 620 (K-035/K-036) — ux_customer_payments_card_reference unique index
-- Source: fix-K-035/docs/audits/remediation/K-036/fix.md
-- One hit makes CREATE UNIQUE INDEX fail; cancel or merge duplicates first.
-- Expected: zero rows. isaflow_dev returns zero across 57 card payments;
-- production has NOT been queried from this session.
-- ============================================================

SELECT count(*) FROM (
  SELECT company_id, bank_reference, count(*) AS duplicates
  FROM customer_payments
  WHERE payment_method = 'card'
    AND bank_reference IS NOT NULL
    AND status IS DISTINCT FROM 'cancelled'
  GROUP BY company_id, bank_reference
  HAVING count(*) > 1
) q;

-- ============================================================
-- Migration 625 (K-015) — supplier_invoices duplicate_fingerprint unique index
-- Source: fix-K-015/docs/audits/remediation/K-015/fix.md
-- Keyed on (company_id, supplier_id, duplicate_fingerprint) per follow-up 2.
-- Rows mean migration 625 aborts the deploy before the rsync.
-- ============================================================

SELECT count(*) FROM (
  SELECT company_id, supplier_id, duplicate_fingerprint, COUNT(*)
    FROM supplier_invoices
   WHERE duplicate_fingerprint IS NOT NULL AND deleted_at IS NULL
   GROUP BY 1, 2, 3
  HAVING COUNT(*) > 1
) q;

-- ============================================================
-- Migration 624 (K-033/K-034) — subscription_charges.subscription_id backfill gate
-- Source: fix-K-033/scripts/migrations/sql/624_subscription_charges_subscription_id.sql
-- (this is the migration's OWN gate query, per review round 5/6 of
-- fix-K-033/docs/audits/remediation/K-033/fix.md)
-- The migration REFUSES to apply while this is > 0; attribute those rows by
-- hand (set subscription_id) and re-run.
-- ============================================================

SELECT count(*) FROM subscription_charges WHERE subscription_id IS NULL;

-- ============================================================
-- Migration 626 (K-039) — practice_client_rate_overrides column-pair mirror trigger
-- Source: fix-K-039/docs/audits/remediation/K-039/fix.md
-- This migration has no hard gate/abort condition (it repairs via trigger +
-- one-time UPDATE rather than refusing to apply); the fix.md's "historical
-- data impact" query below surfaces legacy rows whose column pairs disagree,
-- wrapped here as a count per the requested probe form.
-- ============================================================

SELECT count(*) FROM (
  SELECT company_id, count(*) AS rows,
         count(*) FILTER (WHERE staff_user_id IS DISTINCT FROM user_id) AS user_mismatch,
         count(*) FILTER (WHERE rate_per_hour IS DISTINCT FROM rate)    AS rate_mismatch
  FROM practice_client_rate_overrides GROUP BY company_id
) q;
