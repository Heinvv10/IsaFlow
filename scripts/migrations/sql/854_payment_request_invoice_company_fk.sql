-- 854_payment_request_invoice_company_fk.sql
-- R-195: a Paystack or Stitch payment request may only name an invoice of its OWN company.
--
-- customer_invoice_id on both request tables was a single-column FK (ON DELETE SET NULL), so a
-- request in company B could name company C's invoice: RLS admits every company the user
-- belongs to. The archive skips only invoices a request of the SAME company references (R-186),
-- so C's run deleted the invoice, the SET NULL hit B's row, and paystack_pr_invoice_has_invoice /
-- stitch_pr_invoice_has_invoice failed C's whole run on 23514. The composite FKs below refuse
-- such a request at insert (23503).
--
-- ON DELETE SET NULL (customer_invoice_id) nulls only the invoice column (PG15+; a plain SET NULL
-- would null company_id too, which is NOT NULL). The single-column FKs are kept: they are
-- validated today, and they still guarantee the invoice exists while a composite FK is left
-- NOT VALID below. Deleting an invoice fires both; both null the same column, so the delete
-- behaves exactly as before (an invoice-purpose request still blocks it on 23514).
--
-- Census (read-only; run on prod BEFORE this merges; expected 0 rows):
--
--   SELECT 'paystack' AS gateway, pr.id, pr.company_id AS request_company, ci.company_id AS invoice_company
--   FROM paystack_payment_requests pr JOIN customer_invoices ci ON ci.id = pr.customer_invoice_id
--   WHERE pr.company_id <> ci.company_id
--   UNION ALL
--   SELECT 'stitch', sr.id, sr.company_id, ci.company_id
--   FROM stitch_payment_requests sr JOIN customer_invoices ci ON ci.id = sr.customer_invoice_id
--   WHERE sr.company_id <> ci.company_id;
--
-- The FKs are added NOT VALID, then validated only where that census is 0 for the table. Where
-- it is not, the FK stays NOT VALID (still enforced for every new or changed row) and a NOTICE
-- names the count. No data is changed here; repairing a forged row is Hein's call.
--
-- The runner wraps this file in one transaction, so the locks taken by the UNIQUE build (SHARE on
-- customer_invoices) and the FK adds are held to COMMIT; NOT VALID + VALIDATE here buys no lower
-- lock, only the conditional validate. lock_timeout bounds the wait behind a long transaction;
-- statement_timeout bounds the index build and the scans while the locks are held. Either one
-- firing rolls the whole file back.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'customer_invoices_id_company_id_key' AND conrelid = 'customer_invoices'::regclass
  ) THEN
    ALTER TABLE customer_invoices
      ADD CONSTRAINT customer_invoices_id_company_id_key UNIQUE (id, company_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'paystack_payment_requests_invoice_company_fkey' AND conrelid = 'paystack_payment_requests'::regclass
  ) THEN
    ALTER TABLE paystack_payment_requests
      ADD CONSTRAINT paystack_payment_requests_invoice_company_fkey
      FOREIGN KEY (customer_invoice_id, company_id)
      REFERENCES customer_invoices (id, company_id)
      ON DELETE SET NULL (customer_invoice_id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stitch_payment_requests_invoice_company_fkey' AND conrelid = 'stitch_payment_requests'::regclass
  ) THEN
    ALTER TABLE stitch_payment_requests
      ADD CONSTRAINT stitch_payment_requests_invoice_company_fkey
      FOREIGN KEY (customer_invoice_id, company_id)
      REFERENCES customer_invoices (id, company_id)
      ON DELETE SET NULL (customer_invoice_id)
      NOT VALID;
  END IF;
END $$;

DO $$
DECLARE
  forged INTEGER;
BEGIN
  SELECT count(*) INTO forged
  FROM paystack_payment_requests pr JOIN customer_invoices ci ON ci.id = pr.customer_invoice_id
  WHERE pr.company_id <> ci.company_id;
  IF forged = 0 THEN
    ALTER TABLE paystack_payment_requests VALIDATE CONSTRAINT paystack_payment_requests_invoice_company_fkey;
  ELSE
    RAISE NOTICE 'R-195: % paystack_payment_requests row(s) name another company''s invoice; paystack_payment_requests_invoice_company_fkey left NOT VALID (census in 854_payment_request_invoice_company_fk.sql)', forged;
  END IF;

  SELECT count(*) INTO forged
  FROM stitch_payment_requests sr JOIN customer_invoices ci ON ci.id = sr.customer_invoice_id
  WHERE sr.company_id <> ci.company_id;
  IF forged = 0 THEN
    ALTER TABLE stitch_payment_requests VALIDATE CONSTRAINT stitch_payment_requests_invoice_company_fkey;
  ELSE
    RAISE NOTICE 'R-195: % stitch_payment_requests row(s) name another company''s invoice; stitch_payment_requests_invoice_company_fkey left NOT VALID (census in 854_payment_request_invoice_company_fk.sql)', forged;
  END IF;
END $$;
