-- 620: one card receipt per gateway reference.
--
-- recordGatewayInvoiceReceipt guards against a double receipt with a read of
-- customer_payments.bank_reference followed by an insert. Nothing behind that
-- read enforces it, so a race that slipped past the row locks upstream would
-- bank the same Paystack settlement twice. This turns that into a 23505 the
-- caller can see instead of a silent duplicate.
--
-- Scoped to card payments so manual EFT receipts, which legitimately reuse a
-- bank reference, are unaffected; cancelled rows are excluded so a cancelled
-- receipt can be re-recorded. IS DISTINCT FROM, not <>: status is nullable and
-- `NULL <> 'cancelled'` is NULL, which would drop a NULL-status row out of the
-- index and past the guard.
--
-- Deploy note: run the duplicate check in docs/audits/remediation/K-036/fix.md
-- against production first — a single existing duplicate makes CREATE UNIQUE
-- INDEX fail and stops the deploy here. Built without CONCURRENTLY (the runner
-- wraps migrations in a transaction), so it takes a SHARE lock on
-- customer_payments for the build; run it outside business hours.
CREATE UNIQUE INDEX IF NOT EXISTS ux_customer_payments_card_reference
  ON customer_payments (company_id, bank_reference)
  WHERE payment_method = 'card'
    AND bank_reference IS NOT NULL
    AND status IS DISTINCT FROM 'cancelled';

COMMENT ON INDEX ux_customer_payments_card_reference IS
  'Idempotency for gateway receipts: one confirmed card payment per (company, gateway reference).';
