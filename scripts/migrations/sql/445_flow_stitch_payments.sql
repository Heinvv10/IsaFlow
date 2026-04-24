-- Wire PAYG Flow bundle purchases into the Stitch payment-request table so
-- Flow top-ups flow through the same checkout + webhook path as customer
-- invoice payments (see migration 429 and pages/api/webhooks/stitch.ts).
--
-- Changes:
--   1. Extend `stitch_payment_requests.purpose` CHECK to allow 'flow_bundle'.
--   2. Add nullable FK `flow_purchase_id` that must be populated when
--      purpose='flow_bundle' (mirrors the customer_invoice_id pattern).
--   3. Widen the flow_purchases.payment_method vocabulary with 'stitch_payment_link'.
--
-- Spec: docs/superpowers/specs/2026-04-19-payg-flows-pricing-design.md §10

-- 1. Drop and re-add the purpose CHECK constraint with the new value.
ALTER TABLE stitch_payment_requests
  DROP CONSTRAINT IF EXISTS stitch_payment_requests_purpose_check;

ALTER TABLE stitch_payment_requests
  ADD CONSTRAINT stitch_payment_requests_purpose_check
    CHECK (purpose IN ('customer_invoice','subscription_charge','mandate_authorisation','flow_bundle'));

-- 2. Add the FK column.  Kept nullable so existing invoice/subscription rows
--    stay valid.  A matching CHECK enforces presence when purpose='flow_bundle'.
ALTER TABLE stitch_payment_requests
  ADD COLUMN IF NOT EXISTS flow_purchase_id UUID;

-- Add the FK only if it doesn't exist yet (idempotent re-run).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stitch_payment_requests_flow_purchase_id_fkey'
  ) THEN
    ALTER TABLE stitch_payment_requests
      ADD CONSTRAINT stitch_payment_requests_flow_purchase_id_fkey
        FOREIGN KEY (flow_purchase_id) REFERENCES flow_purchases(id);
  END IF;
END$$;

ALTER TABLE stitch_payment_requests
  DROP CONSTRAINT IF EXISTS stitch_payment_requests_flow_purchase_required;

ALTER TABLE stitch_payment_requests
  ADD CONSTRAINT stitch_payment_requests_flow_purchase_required
    CHECK (purpose <> 'flow_bundle' OR flow_purchase_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_stitch_payment_requests_flow_purchase
  ON stitch_payment_requests(flow_purchase_id)
  WHERE flow_purchase_id IS NOT NULL;

-- 3. Extend the flow_purchases.payment_method vocabulary.
--    No CHECK constraint existed on that column — nothing to drop. But it
--    is useful to surface the allowed values in a COMMENT for future readers.
COMMENT ON COLUMN flow_purchases.payment_method IS
  'Provenance of the payment: admin_recorded (manual admin credit), stitch_payment_link (Stitch Express hosted checkout), auto_topup (gateway-triggered). New values should be documented here.';
