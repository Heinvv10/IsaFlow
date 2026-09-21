-- 691: a processed supplier payment batch can be REVERSED.
--
-- K-063 round 5b: a batch member may only move money through its batch, so a
-- processed batch needs its own reversal (batchPaymentReversal.ts). The batch
-- ends in 'reversed', a terminal status distinct from 'cancelled': cancelled
-- means nothing was ever posted; reversed means the batch journal stands with
-- exactly one posted contra beside it.
--
-- Schema only, no DML. Idempotent: the constraint is replaced whole.

DO $$
BEGIN
  ALTER TABLE supplier_payment_batches DROP CONSTRAINT IF EXISTS supplier_payment_batches_status_check;
  ALTER TABLE supplier_payment_batches ADD CONSTRAINT supplier_payment_batches_status_check
    CHECK (status IN ('draft', 'approved', 'processed', 'cancelled', 'reversed'));
END $$;
