-- 958: payment terms model for suppliers and customers (payment-terms / due-by-date plan, PR 1,
-- docs/plans/2026-11-05-payment-terms-due-by-date.md, decisions 2 and 3).
--
-- payment_terms (integer N) stays; payment_terms_type now says what N counts:
--   invoice_days      invoice date + N days (N = 0 is Immediate)
--   statement_days    month-end of the invoice month + N days
--   statement_months  month-end of the Nth month after the invoice month
--   NULL / NULL       "not set": the terms give no date
--
-- Data, all tenants on purpose (this is a column-semantics change, not tenant data):
--   1. A row still on the column default (payment_terms = 30 with type 'days' or NULL) was never chosen: it becomes
--      not set. Hein / Willie confirm the real terms of the material suppliers afterwards.
--   2. Legacy 'days' (or NULL) becomes invoice_days; 'end_of_month' becomes statement_days. N is kept.
--   3. A NULL or negative N, or a type nobody defined, becomes not set (before this change such terms gave no
--      due date either).
-- The DEFAULT on both columns is dropped: a new row has no terms until someone sets them.
--
-- A CHECK then holds the pair together: both NULL, or N >= 0 with one of the three types (each branch spelled
-- IS NOT NULL: a CHECK passes on NULL, so a bare comparison would let N through with no type). It is added NOT VALID
-- and validated in the same file (both tables are small; the lock is held to commit, so the 5s lock_timeout below
-- fails the deploy rather than queueing every request behind a busy table).
-- Safe to re-run: step 1 only matches the legacy type names, so a row set to 30 invoice_days afterwards stays.

SET LOCAL lock_timeout = '5s';

ALTER TABLE suppliers ALTER COLUMN payment_terms DROP DEFAULT;
ALTER TABLE suppliers ALTER COLUMN payment_terms_type DROP DEFAULT;
ALTER TABLE customers ALTER COLUMN payment_terms DROP DEFAULT;
ALTER TABLE customers ALTER COLUMN payment_terms_type DROP DEFAULT;

-- 1. Still on the default: not set.
UPDATE suppliers SET payment_terms = NULL, payment_terms_type = NULL
WHERE payment_terms = 30 AND COALESCE(payment_terms_type, 'days') = 'days';

UPDATE customers SET payment_terms = NULL, payment_terms_type = NULL
WHERE payment_terms = 30 AND COALESCE(payment_terms_type, 'days') = 'days';

-- 2 and 3. Every other row not yet in the new shape. The right-hand sides read the OLD row, so both CASEs
-- see the same legacy type.
UPDATE suppliers SET
  payment_terms_type = CASE
    WHEN payment_terms IS NULL OR payment_terms < 0 THEN NULL
    WHEN payment_terms_type IS NULL OR payment_terms_type = 'days' THEN 'invoice_days'
    WHEN payment_terms_type = 'end_of_month' THEN 'statement_days'
    WHEN payment_terms_type IN ('invoice_days', 'statement_days', 'statement_months') THEN payment_terms_type
    ELSE NULL END,
  payment_terms = CASE
    WHEN payment_terms >= 0 AND (payment_terms_type IS NULL OR payment_terms_type IN
      ('days', 'end_of_month', 'invoice_days', 'statement_days', 'statement_months')) THEN payment_terms
    ELSE NULL END
WHERE ((payment_terms IS NULL AND payment_terms_type IS NULL)
    OR (payment_terms >= 0 AND payment_terms_type IN ('invoice_days', 'statement_days', 'statement_months')))
  IS NOT TRUE;

UPDATE customers SET
  payment_terms_type = CASE
    WHEN payment_terms IS NULL OR payment_terms < 0 THEN NULL
    WHEN payment_terms_type IS NULL OR payment_terms_type = 'days' THEN 'invoice_days'
    WHEN payment_terms_type = 'end_of_month' THEN 'statement_days'
    WHEN payment_terms_type IN ('invoice_days', 'statement_days', 'statement_months') THEN payment_terms_type
    ELSE NULL END,
  payment_terms = CASE
    WHEN payment_terms >= 0 AND (payment_terms_type IS NULL OR payment_terms_type IN
      ('days', 'end_of_month', 'invoice_days', 'statement_days', 'statement_months')) THEN payment_terms
    ELSE NULL END
WHERE ((payment_terms IS NULL AND payment_terms_type IS NULL)
    OR (payment_terms >= 0 AND payment_terms_type IN ('invoice_days', 'statement_days', 'statement_months')))
  IS NOT TRUE;

ALTER TABLE suppliers DROP CONSTRAINT IF EXISTS suppliers_payment_terms_shape;
ALTER TABLE suppliers ADD CONSTRAINT suppliers_payment_terms_shape CHECK (
  (payment_terms IS NULL AND payment_terms_type IS NULL)
  OR (payment_terms IS NOT NULL AND payment_terms >= 0 AND payment_terms_type IS NOT NULL
      AND payment_terms_type IN ('invoice_days', 'statement_days', 'statement_months'))
) NOT VALID;
ALTER TABLE suppliers VALIDATE CONSTRAINT suppliers_payment_terms_shape;

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_payment_terms_shape;
ALTER TABLE customers ADD CONSTRAINT customers_payment_terms_shape CHECK (
  (payment_terms IS NULL AND payment_terms_type IS NULL)
  OR (payment_terms IS NOT NULL AND payment_terms >= 0 AND payment_terms_type IS NOT NULL
      AND payment_terms_type IN ('invoice_days', 'statement_days', 'statement_months'))
) NOT VALID;
ALTER TABLE customers VALIDATE CONSTRAINT customers_payment_terms_shape;

COMMENT ON COLUMN suppliers.payment_terms IS
  'N for payment_terms_type (days or months). NULL with a NULL type: terms not set.';
COMMENT ON COLUMN suppliers.payment_terms_type IS
  'invoice_days | statement_days | statement_months; NULL = not set (migration 958).';
COMMENT ON COLUMN customers.payment_terms IS
  'N for payment_terms_type (days or months). NULL with a NULL type: terms not set.';
COMMENT ON COLUMN customers.payment_terms_type IS
  'invoice_days | statement_days | statement_months; NULL = not set (migration 958).';
