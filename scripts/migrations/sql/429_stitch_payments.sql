-- Stitch Money integration — payment gateway for both:
--   1. Customer invoice payments (PRD-06 portal, once-off)
--   2. IsaFlow subscription billing (admin platform, recurring via LinkPay mandate)
--
-- Three tables:
--   stitch_payment_requests     — every checkout session we create (invoice OR subscription)
--   subscription_mandates       — LinkPay authorisations for recurring debits
--   subscription_charges        — individual debit attempts against a mandate
--
-- Webhooks are the source of truth; the browser redirect is UX only.
-- All amounts stored in cents (BIGINT) to match companies.plan pricing conventions.

CREATE TABLE IF NOT EXISTS stitch_payment_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- what are we collecting for?
  purpose TEXT NOT NULL
    CHECK (purpose IN ('customer_invoice','subscription_charge','mandate_authorisation')),
  customer_invoice_id UUID REFERENCES customer_invoices(id) ON DELETE SET NULL,
  subscription_charge_id UUID,
  mandate_id UUID,

  -- Stitch identifiers
  stitch_payment_id TEXT UNIQUE,            -- PaymentInitiation node id
  external_reference TEXT NOT NULL,          -- our correlation id sent to Stitch
  checkout_url TEXT,                         -- Stitch-hosted URL we redirect the payer to

  -- money
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  currency CHAR(3) NOT NULL DEFAULT 'ZAR',

  -- lifecycle:  pending → received → completed | failed | cancelled | expired
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','received','completed','failed','cancelled','expired')),
  failure_reason TEXT,

  payer_name TEXT,
  payer_email TEXT,
  payment_method TEXT,                       -- 'card' | 'pbb' | 'linkpay' | 'capitec_pay' | etc.

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,

  CONSTRAINT stitch_pr_invoice_has_invoice
    CHECK (purpose <> 'customer_invoice' OR customer_invoice_id IS NOT NULL),
  CONSTRAINT stitch_pr_subscription_has_charge
    CHECK (purpose <> 'subscription_charge' OR subscription_charge_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_stitch_pr_company_status
  ON stitch_payment_requests(company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stitch_pr_invoice
  ON stitch_payment_requests(customer_invoice_id)
  WHERE customer_invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stitch_pr_ext_ref
  ON stitch_payment_requests(external_reference);

DROP TRIGGER IF EXISTS trg_stitch_payment_requests_updated_at
  ON stitch_payment_requests;
CREATE TRIGGER trg_stitch_payment_requests_updated_at
  BEFORE UPDATE ON stitch_payment_requests
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- Subscription mandates (LinkPay authorisations)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscription_mandates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Stitch references
  stitch_authorisation_id TEXT UNIQUE,       -- PaymentAuthorizationRequest id
  stitch_bank_account_id TEXT,               -- returned token we reuse for each debit
  stitch_user_id TEXT,                       -- Stitch user/account owner id

  -- bank detail snapshot (for display only — never used to debit)
  bank_name TEXT,
  account_holder TEXT,
  masked_account_number TEXT,

  -- authorisation config
  max_amount_cents BIGINT NOT NULL CHECK (max_amount_cents > 0),
  currency CHAR(3) NOT NULL DEFAULT 'ZAR',
  authorised_by VARCHAR(255) REFERENCES users(id),

  -- lifecycle:  pending → active → revoked | expired | failed
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','active','revoked','expired','failed')),
  authorised_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sub_mandates_company_status
  ON subscription_mandates(company_id, status);

-- Only one ACTIVE mandate per company at a time.
CREATE UNIQUE INDEX IF NOT EXISTS ux_sub_mandates_company_active
  ON subscription_mandates(company_id)
  WHERE status = 'active';

DROP TRIGGER IF EXISTS trg_subscription_mandates_updated_at
  ON subscription_mandates;
CREATE TRIGGER trg_subscription_mandates_updated_at
  BEFORE UPDATE ON subscription_mandates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- Subscription charges (individual debit attempts)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscription_charges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  mandate_id UUID NOT NULL REFERENCES subscription_mandates(id) ON DELETE RESTRICT,

  -- billing period this charge covers
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,

  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  currency CHAR(3) NOT NULL DEFAULT 'ZAR',

  -- Stitch references
  stitch_payment_id TEXT UNIQUE,
  external_reference TEXT NOT NULL,

  -- lifecycle:  queued → submitted → settled | failed | cancelled
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','submitted','settled','failed','cancelled')),
  attempt_count INT NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  failure_reason TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT sub_charges_period_sane CHECK (period_end >= period_start)
);

CREATE INDEX IF NOT EXISTS idx_sub_charges_company_status
  ON subscription_charges(company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sub_charges_mandate
  ON subscription_charges(mandate_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sub_charges_queued
  ON subscription_charges(company_id, period_start)
  WHERE status IN ('queued','failed');

-- One settled charge per (mandate, period) — retries allowed until settled.
CREATE UNIQUE INDEX IF NOT EXISTS ux_sub_charges_mandate_period_settled
  ON subscription_charges(mandate_id, period_start, period_end)
  WHERE status = 'settled';

DROP TRIGGER IF EXISTS trg_subscription_charges_updated_at
  ON subscription_charges;
CREATE TRIGGER trg_subscription_charges_updated_at
  BEFORE UPDATE ON subscription_charges
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Back-fill FKs from stitch_payment_requests once the dependent tables exist.
ALTER TABLE stitch_payment_requests
  DROP CONSTRAINT IF EXISTS stitch_pr_mandate_fk,
  ADD CONSTRAINT stitch_pr_mandate_fk
    FOREIGN KEY (mandate_id) REFERENCES subscription_mandates(id) ON DELETE SET NULL;

ALTER TABLE stitch_payment_requests
  DROP CONSTRAINT IF EXISTS stitch_pr_charge_fk,
  ADD CONSTRAINT stitch_pr_charge_fk
    FOREIGN KEY (subscription_charge_id) REFERENCES subscription_charges(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Webhook event log (Svix) — idempotency + audit trail
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stitch_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  svix_id TEXT NOT NULL UNIQUE,              -- prevents double-processing
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  processed BOOLEAN NOT NULL DEFAULT FALSE,
  processing_error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_stitch_webhook_events_unprocessed
  ON stitch_webhook_events(received_at)
  WHERE processed = FALSE;

COMMENT ON TABLE stitch_payment_requests IS
  'Stitch Money checkout sessions — both customer invoice payins and subscription debits.';
COMMENT ON TABLE subscription_mandates IS
  'Stitch LinkPay authorisations — one active per company, enables recurring billing without re-auth.';
COMMENT ON TABLE subscription_charges IS
  'Monthly debit attempts against a subscription_mandate. Driven by billing cron.';
COMMENT ON TABLE stitch_webhook_events IS
  'Raw Svix webhook log — svix_id unique constraint provides idempotency.';

GRANT SELECT, INSERT, UPDATE ON stitch_payment_requests TO app_user;
GRANT SELECT, INSERT, UPDATE ON subscription_mandates TO app_user;
GRANT SELECT, INSERT, UPDATE ON subscription_charges TO app_user;
GRANT SELECT, INSERT, UPDATE ON stitch_webhook_events TO app_user;
