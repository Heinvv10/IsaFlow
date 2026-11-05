-- 958: payment terms model, EXPAND step (payment-terms / due-by-date plan, PR 1,
-- docs/plans/2026-11-05-payment-terms-due-by-date.md, decisions 2 and 3 and the company-default ruling).
--
-- payment_terms (integer N) stays; payment_terms_type now says what N counts:
--   invoice_days      invoice date + N days (N = 0 is Immediate)
--   statement_days    month-end of the invoice month + N days
--   statement_months  month-end of the Nth month after the invoice month
--   NULL / NULL       "not set": the contact uses its company's default terms
--
-- This is the EXPAND half of an expand / tighten split. The build that ships it runs beside the old code (the live colour
-- during the build, and after a code-only rollback), and the old code still writes the old shapes: createSupplier
-- writes (30, NULL), createCustomer (N, 'days'), the migration importer `?? 30`. So this file adds NO CHECK and drops NO
-- DEFAULT; the new code reads every legacy shape (shared/paymentTerms.readTerms: 'days' = invoice_days,
-- 'end_of_month' = statement_days, a number with no type = invoice_days). The tightening (DROP DEFAULT, a CHECK that
-- also caps N at 999) is PR 1b, applied only after the new code is live; see the plan doc.
--
-- Data, all tenants on purpose (this is a column-semantics change, not tenant data):
--   1. A row still on the column default (payment_terms = 30 with type 'days' or NULL) was never chosen: it becomes
--      not set, and now means "the company default", which starts at 30 days from invoice, so nothing changes in the
--      due dates the contact produces. Hein / Willie confirm the real terms of the material suppliers afterwards.
--   2. Legacy 'days' (or NULL) becomes invoice_days; 'end_of_month' becomes statement_days. N is kept.
--   3. A NULL, negative or over-999 N, or a type nobody defined, becomes not set (those gave no due date, or one the
--      forms refuse).
--
-- Company default terms: no schema. They are the accounting_settings row `default_payment_terms` (JSON, per company), written
-- by Company settings; no row means 30 days from invoice, which is every company's start. (companies is column-level
-- read-only for the app pools since 936, so a new column there would not be writable by a tenant.)
--
-- Safe to re-run: step 1 only matches the legacy type names, so a row set to 30 invoice_days afterwards stays. Waits at
-- most 5s for a table lock, so a busy table fails the deploy instead of queueing every request behind it.

SET LOCAL lock_timeout = '5s';

-- 1. Still on the default: not set.
UPDATE suppliers SET payment_terms = NULL, payment_terms_type = NULL
WHERE payment_terms = 30 AND COALESCE(payment_terms_type, 'days') = 'days';

UPDATE customers SET payment_terms = NULL, payment_terms_type = NULL
WHERE payment_terms = 30 AND COALESCE(payment_terms_type, 'days') = 'days';

-- 2 and 3. Every other row not yet in the new shape. The right-hand sides read the OLD row, so both CASEs
-- see the same legacy type.
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

COMMENT ON COLUMN suppliers.payment_terms IS
  'N for payment_terms_type (days or months). NULL with a NULL type: terms not set, the company default applies.';
COMMENT ON COLUMN suppliers.payment_terms_type IS
  'invoice_days | statement_days | statement_months; NULL = not set (migration 958). Old code still writes days / end_of_month until PR 1b.';
COMMENT ON COLUMN customers.payment_terms IS
  'N for payment_terms_type (days or months). NULL with a NULL type: terms not set, the company default applies.';
COMMENT ON COLUMN customers.payment_terms_type IS
  'invoice_days | statement_days | statement_months; NULL = not set (migration 958). Old code still writes days / end_of_month until PR 1b.';
