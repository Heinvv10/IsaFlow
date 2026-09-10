-- K-096 follow-up: link an authorisation checkout to the mandate it was
-- started for.
--
-- Until now nothing in the schema resolved a paystack_reference to a
-- subscription_mandates row. pages/api/billing/paystack/mandate/create.ts
-- created the pending mandate and then the payment request, and passed the
-- mandate id only in the Paystack *metadata*, which the verify path cannot
-- read back. Both the verify route and the charge.success webhook therefore
-- guessed: "the newest pending paystack mandate for this company". With two
-- abandoned checkouts that guess activates the wrong row, and the activated
-- mandate carries a max_amount_cents ceiling the customer never authorised on
-- the reference being verified.
--
-- The column is nullable on purpose. Rows written before this migration have
-- no recoverable link — the metadata lives at Paystack, not here — so the two
-- readers keep their old heuristic for a NULL and use the link when it exists.

ALTER TABLE paystack_payment_requests
  ADD COLUMN IF NOT EXISTS mandate_id UUID
    REFERENCES subscription_mandates(id) ON DELETE SET NULL;

COMMENT ON COLUMN paystack_payment_requests.mandate_id IS
  'For purpose=authorization: the subscription_mandates row this checkout was started for. NULL for rows created before migration 651.';

CREATE INDEX IF NOT EXISTS idx_paystack_pr_mandate_id
  ON paystack_payment_requests (mandate_id)
  WHERE mandate_id IS NOT NULL;
