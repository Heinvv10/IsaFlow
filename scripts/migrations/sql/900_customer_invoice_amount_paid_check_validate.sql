-- 900: validate customer_invoices_amount_paid_within_total (added NOT VALID by 899).
--
-- Census, production, read-only, 2026-10-20: 2546 customer invoices, 0 live
-- rows with amount_paid > total_amount; ONE soft-deleted cancelled invoice
-- with total_amount = -115.00 and amount_paid = 0, which the constraint's
-- GREATEST(total_amount, 0) admits. isaflow_dev: 0 violators, 0 negative
-- totals. Re-run before deploying (expect 0 rows; a row here fails this
-- migration and rolls back only this file, 899 stays applied):
--
--   SELECT id, company_id, invoice_number, total_amount, amount_paid
--   FROM customer_invoices
--   WHERE amount_paid > GREATEST(total_amount, 0)
--      OR amount_paid = 'NaN'::numeric;
--
-- Its own transaction/file so VALIDATE's scan runs under SHARE UPDATE
-- EXCLUSIVE and never holds 899's ACCESS EXCLUSIVE ADD CONSTRAINT lock.
-- VALIDATE on an already-validated constraint is a no-op, so re-running is safe.

ALTER TABLE public.customer_invoices
  VALIDATE CONSTRAINT customer_invoices_amount_paid_within_total;
