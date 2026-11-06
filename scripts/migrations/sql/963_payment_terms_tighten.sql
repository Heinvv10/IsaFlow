-- 963: payment terms, the TIGHTEN half (PR 1b; plan docs/plans/2026-11-05-payment-terms-due-by-date.md, "Expand / tighten").
-- Applied only once no colour runs pre-PR-1 code (2026-11-07: live 87a5542b6 and idle 32a20d374 both read every shape
-- through shared/paymentTerms.readTerms and write only the new one), so no reader is left that a new shape would undate.
--
--   1. Contacts still on the old column default, (30, 'days') or (30, NULL), become NOT SET (Hein, 2026-11-05, ruling (a)):
--      they were stamped by the old createSupplier / createCustomer, not chosen, and a not-set contact follows the company
--      default. EXCEPT in a company whose default is no longer 30 days from invoice (Hein, 2026-11-07): old createCustomer
--      wrote (30, 'days') for a real "30 days" choice too, so there a stamped row may be real terms, and following the
--      company's changed default would move its due dates. Those rows become an explicit 30 days from invoice instead
--      (step 2), which dates exactly as before. "Still 30 days from invoice" = no setting row, or the exact value the app
--      writes for it; anything else (another default, or an unreadable value) counts as changed and is left dated as now.
--   2. Every other row not yet in the new shape: 'days' or no type -> invoice_days, 'end_of_month' -> statement_days; a
--      negative, over-999 or unknown-type row, or a type with no number, becomes not set (readTerms already reads those
--      as no terms, so nothing that dated before is undated by this).
--   3. A CHECK so the pair is always one of the new shapes (N 0..999 with a type, or both NULL), as the forms enforce.
--      Each arm names IS NOT NULL: a CHECK that evaluates to NULL passes, and `NULL IN (...)` is NULL, so without them
--      (30, NULL) and (NULL, 'invoice_days') would be accepted.
--
-- Undo record: every UPDATE fires migration 888's change-history capture (ENABLE ALWAYS on suppliers and customers), which
-- records payment_terms / payment_terms_type before and after, channel 'system'. There is no other copy of the old values:
-- do not disable that trigger, and keep the history rows it writes.
--
-- Idempotent: a second run finds nothing to change (step 1's rows are gone, step 2's WHERE excludes the new shapes, the
-- constraint is added only when missing). Cross-tenant by design: the mapping is the same rule for every company, each
-- row judged against its own company's default.
--
-- Locks: row locks on the contacts it changes (each fires one capture insert), then ACCESS EXCLUSIVE on suppliers and
-- customers for the constraint (NOT VALID add, then VALIDATE inside the same transaction: one scan each). A lock not
-- granted within 5s aborts the migration, which has then changed nothing. Deploy after hours.

SET LOCAL lock_timeout = '5s';

-- ── 1. Stamped defaults -> not set, where the company default is still 30 days from invoice ──
UPDATE suppliers s SET payment_terms = NULL, payment_terms_type = NULL
WHERE s.payment_terms = 30 AND COALESCE(s.payment_terms_type, 'days') = 'days'
  AND NOT EXISTS (
    SELECT 1 FROM accounting_settings a
    WHERE a.company_id = s.company_id AND a.key = 'default_payment_terms'
      AND a.value IS DISTINCT FROM '{"days":30,"type":"invoice_days"}');

UPDATE customers c SET payment_terms = NULL, payment_terms_type = NULL
WHERE c.payment_terms = 30 AND COALESCE(c.payment_terms_type, 'days') = 'days'
  AND NOT EXISTS (
    SELECT 1 FROM accounting_settings a
    WHERE a.company_id = c.company_id AND a.key = 'default_payment_terms'
      AND a.value IS DISTINCT FROM '{"days":30,"type":"invoice_days"}');

-- ── 2. Every other row not yet in the new shape. The right-hand sides read the OLD row, so both CASEs see the same type ──
UPDATE suppliers SET
  payment_terms_type = CASE
    WHEN payment_terms IS NULL OR payment_terms < 0 OR payment_terms > 999 THEN NULL
    WHEN payment_terms_type IS NULL OR payment_terms_type = 'days' THEN 'invoice_days'
    WHEN payment_terms_type = 'end_of_month' THEN 'statement_days'
    WHEN payment_terms_type IN ('invoice_days', 'statement_days', 'statement_months') THEN payment_terms_type
    ELSE NULL END,
  payment_terms = CASE
    WHEN payment_terms BETWEEN 0 AND 999 AND (payment_terms_type IS NULL OR payment_terms_type IN
      ('days', 'end_of_month', 'invoice_days', 'statement_days', 'statement_months')) THEN payment_terms
    ELSE NULL END
WHERE ((payment_terms IS NULL AND payment_terms_type IS NULL)
    OR (payment_terms BETWEEN 0 AND 999 AND payment_terms_type IN ('invoice_days', 'statement_days', 'statement_months')))
  IS NOT TRUE;

UPDATE customers SET
  payment_terms_type = CASE
    WHEN payment_terms IS NULL OR payment_terms < 0 OR payment_terms > 999 THEN NULL
    WHEN payment_terms_type IS NULL OR payment_terms_type = 'days' THEN 'invoice_days'
    WHEN payment_terms_type = 'end_of_month' THEN 'statement_days'
    WHEN payment_terms_type IN ('invoice_days', 'statement_days', 'statement_months') THEN payment_terms_type
    ELSE NULL END,
  payment_terms = CASE
    WHEN payment_terms BETWEEN 0 AND 999 AND (payment_terms_type IS NULL OR payment_terms_type IN
      ('days', 'end_of_month', 'invoice_days', 'statement_days', 'statement_months')) THEN payment_terms
    ELSE NULL END
WHERE ((payment_terms IS NULL AND payment_terms_type IS NULL)
    OR (payment_terms BETWEEN 0 AND 999 AND payment_terms_type IN ('invoice_days', 'statement_days', 'statement_months')))
  IS NOT TRUE;

-- ── 3. The shape, once nothing violates it ──
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                 WHERE conrelid = 'public.suppliers'::pg_catalog.regclass AND conname = 'suppliers_payment_terms_shape') THEN
    ALTER TABLE public.suppliers ADD CONSTRAINT suppliers_payment_terms_shape CHECK (
      (payment_terms IS NULL AND payment_terms_type IS NULL)
      OR (payment_terms IS NOT NULL AND payment_terms_type IS NOT NULL AND payment_terms BETWEEN 0 AND 999
          AND payment_terms_type IN ('invoice_days', 'statement_days', 'statement_months'))) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                 WHERE conrelid = 'public.customers'::pg_catalog.regclass AND conname = 'customers_payment_terms_shape') THEN
    ALTER TABLE public.customers ADD CONSTRAINT customers_payment_terms_shape CHECK (
      (payment_terms IS NULL AND payment_terms_type IS NULL)
      OR (payment_terms IS NOT NULL AND payment_terms_type IS NOT NULL AND payment_terms BETWEEN 0 AND 999
          AND payment_terms_type IN ('invoice_days', 'statement_days', 'statement_months'))) NOT VALID;
  END IF;
END $$;
ALTER TABLE suppliers VALIDATE CONSTRAINT suppliers_payment_terms_shape;
ALTER TABLE customers VALIDATE CONSTRAINT customers_payment_terms_shape;
