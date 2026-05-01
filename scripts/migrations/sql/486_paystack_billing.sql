-- Paystack billing — replaces Stitch as the payment gateway for:
--   1. Customer invoice payments (PRD-06 portal, once-off)
--   2. ISAFlow's own SaaS subscription billing (recurring via charge_authorization)
--   3. PAYG Flow bundle top-ups
--
-- We keep the legacy `stitch_*` tables in place as historical records
-- (they hold prod data) but introduce new gateway-agnostic Paystack tables
-- and add Paystack columns to the shared lifecycle tables.
--
-- Money is stored in cents (BIGINT). For ZAR, Paystack's "smallest currency
-- unit" is also cents (×100), so the wire format matches our storage 1:1.
--
-- Webhook idempotency uses sha256 of the raw body (Paystack does not emit
-- a per-event id). The hash is the natural dedup key for retries.

-- ---------------------------------------------------------------------------
-- 1. Paystack payment requests — every checkout we initialise
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS paystack_payment_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- what is the payment for?
  purpose TEXT NOT NULL
    CHECK (purpose IN ('customer_invoice','subscription_charge','authorization','flow_bundle')),
  customer_invoice_id UUID REFERENCES customer_invoices(id) ON DELETE SET NULL,
  subscription_charge_id UUID,
  flow_purchase_id UUID REFERENCES flow_purchases(id) ON DELETE SET NULL,

  -- Paystack identifiers
  paystack_reference TEXT NOT NULL UNIQUE,    -- our reference, sent to Paystack
  paystack_access_code TEXT,                  -- returned by /transaction/initialize
  paystack_transaction_id BIGINT,             -- numeric id, populated after charge.success
  paystack_authorization_code TEXT,           -- captured for reuse (subscriptions, charge_auth)
  paystack_customer_code TEXT,                -- CUS_xxx
  authorization_url TEXT,                     -- hosted checkout url we redirect to

  -- money
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  currency CHAR(3) NOT NULL DEFAULT 'ZAR',

  -- lifecycle: pending → completed | failed | cancelled | abandoned
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','completed','failed','cancelled','abandoned')),
  failure_reason TEXT,
  channel TEXT,                               -- card, bank, ussd, mobile_money, etc

  payer_name TEXT,
  payer_email TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,

  CONSTRAINT paystack_pr_invoice_has_invoice
    CHECK (purpose <> 'customer_invoice' OR customer_invoice_id IS NOT NULL),
  CONSTRAINT paystack_pr_flow_has_purchase
    CHECK (purpose <> 'flow_bundle' OR flow_purchase_id IS NOT NULL),
  CONSTRAINT paystack_pr_subcharge_has_charge
    CHECK (purpose <> 'subscription_charge' OR subscription_charge_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_paystack_pr_company_status
  ON paystack_payment_requests(company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_paystack_pr_invoice
  ON paystack_payment_requests(customer_invoice_id)
  WHERE customer_invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_paystack_pr_flow_purchase
  ON paystack_payment_requests(flow_purchase_id)
  WHERE flow_purchase_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_paystack_payment_requests_updated_at
  ON paystack_payment_requests;
CREATE TRIGGER trg_paystack_payment_requests_updated_at
  BEFORE UPDATE ON paystack_payment_requests
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- 2. Subscription mandates — extend with Paystack columns
--    (legacy stitch_* columns stay so historical rows remain readable)
-- ---------------------------------------------------------------------------
ALTER TABLE subscription_mandates
  ADD COLUMN IF NOT EXISTS gateway TEXT NOT NULL DEFAULT 'paystack'
    CHECK (gateway IN ('stitch','paystack'));
ALTER TABLE subscription_mandates
  ADD COLUMN IF NOT EXISTS paystack_authorization_code TEXT;
ALTER TABLE subscription_mandates
  ADD COLUMN IF NOT EXISTS paystack_customer_code TEXT;
ALTER TABLE subscription_mandates
  ADD COLUMN IF NOT EXISTS paystack_subscription_code TEXT;
ALTER TABLE subscription_mandates
  ADD COLUMN IF NOT EXISTS paystack_email_token TEXT;
ALTER TABLE subscription_mandates
  ADD COLUMN IF NOT EXISTS card_last4 TEXT;
ALTER TABLE subscription_mandates
  ADD COLUMN IF NOT EXISTS card_brand TEXT;
ALTER TABLE subscription_mandates
  ADD COLUMN IF NOT EXISTS card_exp_month TEXT;
ALTER TABLE subscription_mandates
  ADD COLUMN IF NOT EXISTS card_exp_year TEXT;

CREATE INDEX IF NOT EXISTS idx_sub_mandates_paystack_auth
  ON subscription_mandates(paystack_authorization_code)
  WHERE paystack_authorization_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sub_mandates_gateway_company
  ON subscription_mandates(gateway, company_id, status);

-- ---------------------------------------------------------------------------
-- 3. Subscription charges — extend with Paystack columns
-- ---------------------------------------------------------------------------
ALTER TABLE subscription_charges
  ADD COLUMN IF NOT EXISTS gateway TEXT NOT NULL DEFAULT 'paystack'
    CHECK (gateway IN ('stitch','paystack'));
ALTER TABLE subscription_charges
  ADD COLUMN IF NOT EXISTS paystack_reference TEXT;
ALTER TABLE subscription_charges
  ADD COLUMN IF NOT EXISTS paystack_authorization_code TEXT;

CREATE INDEX IF NOT EXISTS idx_sub_charges_paystack_ref
  ON subscription_charges(paystack_reference)
  WHERE paystack_reference IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Paystack webhook events — idempotency log
--    Paystack does NOT emit a per-event id. We dedup on sha256(raw_body).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS paystack_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  body_sha256 TEXT NOT NULL UNIQUE,           -- prevents double-processing
  event_type TEXT NOT NULL,
  reference TEXT,                             -- pulled from event.data.reference for fast lookup
  payload JSONB NOT NULL,
  processed BOOLEAN NOT NULL DEFAULT FALSE,
  processing_error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_paystack_webhook_events_unprocessed
  ON paystack_webhook_events(received_at)
  WHERE processed = FALSE;
CREATE INDEX IF NOT EXISTS idx_paystack_webhook_events_reference
  ON paystack_webhook_events(reference)
  WHERE reference IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. Permissions
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON paystack_payment_requests TO app_user;
GRANT SELECT, INSERT, UPDATE ON paystack_webhook_events TO app_user;

COMMENT ON TABLE paystack_payment_requests IS
  'Paystack checkout sessions — customer invoice payins, SaaS subscription auth, Flow bundle top-ups.';
COMMENT ON TABLE paystack_webhook_events IS
  'Raw Paystack webhook log. body_sha256 unique constraint provides idempotency since Paystack lacks per-event ids.';
COMMENT ON COLUMN subscription_mandates.paystack_authorization_code IS
  'Paystack authorization_code (AUTH_xxx). Required for charge_authorization recurring debits.';
COMMENT ON COLUMN subscription_mandates.gateway IS
  'Which gateway authorised this mandate. Legacy rows = stitch; new rows = paystack.';
