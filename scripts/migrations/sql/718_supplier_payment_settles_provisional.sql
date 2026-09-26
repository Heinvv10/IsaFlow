-- 718 (R-127): a bank-first provisional journal can become the payment of ONE
-- supplier invoice.
--
-- When a supplier invoice is approved and its source document already
-- evidences a provisional journal (DR expense / DR VAT, CR bank), the approval
-- reclasses the provisional into the invoice's payment and records a
-- supplier_payments row for it (ap/provisionalInvoiceSettlement.ts). This
-- column names the provisional that payment consumed, and the partial unique
-- index is the claim: while one live payment holds a provisional, no second
-- payment can — so one bank outflow cannot settle two invoices even if the
-- row lock in the application is bypassed. A cancelled (voided) payment
-- releases the claim.
ALTER TABLE supplier_payments
  ADD COLUMN IF NOT EXISTS settles_provisional_je_id UUID REFERENCES gl_journal_entries(id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_payments_settles_provisional_je
  ON supplier_payments (settles_provisional_je_id)
  WHERE settles_provisional_je_id IS NOT NULL AND status <> 'cancelled';
