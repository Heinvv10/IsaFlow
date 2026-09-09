-- 619: one card receipt per gateway reference.
--
-- recordGatewayInvoiceReceipt guards against a double receipt with a read of
-- customer_payments.bank_reference followed by an insert. Nothing behind that
-- read enforces it, so a race that slipped past the row locks upstream would
-- bank the same Paystack settlement twice. This turns that into a 23505 the
-- caller can see instead of a silent duplicate.
--
-- Scoped to card payments so manual EFT receipts, which legitimately reuse a
-- bank reference, are unaffected; cancelled rows are excluded so a cancelled
-- receipt can be re-recorded.
CREATE UNIQUE INDEX IF NOT EXISTS ux_customer_payments_card_reference
  ON customer_payments (company_id, bank_reference)
  WHERE payment_method = 'card'
    AND bank_reference IS NOT NULL
    AND status <> 'cancelled';

COMMENT ON INDEX ux_customer_payments_card_reference IS
  'Idempotency for gateway receipts: one confirmed card payment per (company, gateway reference).';
