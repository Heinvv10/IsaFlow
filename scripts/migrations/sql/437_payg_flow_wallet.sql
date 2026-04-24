-- Migration 437: PAYG Flow Wallet
--
-- Ships the Pay-As-You-Go "Flows" micro-pricing subsystem:
--   1. `payg` row in `plans` (monthly_price_cents = 0, limits.max_users = 1)
--   2. `companies.payg_eligible` flag + optional declared `annual_turnover_cents`
--   3. `flow_bundles`  — purchasable packs (seeded with 4 tiers)
--   4. `flow_wallet`   — one row per PAYG company (balance + nudge + auto-topup cfg)
--   5. `flow_ledger`   — immutable audit log (purchase / debit / refund / admin_adjustment)
--   6. `flow_purchases`— payment records
--
-- Spec: docs/superpowers/specs/2026-04-19-payg-flows-pricing-design.md
-- Plan: docs/superpowers/plans/2026-04-24-payg-flows-implementation.md (Task 1)

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. `payg` plan row  (display_order 0 so it sits above Starter)
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO plans (code, name, description, monthly_price_cents, annual_price_cents,
                   currency, limits, display_order)
VALUES (
  'payg',
  'Pay-As-You-Go',
  'Prepaid Flows — pay only for what you use. Designed for micro enterprises under R1M turnover.',
  0,
  0,
  'ZAR',
  '{"max_users": 1, "max_companies": 1}',
  0
)
ON CONFLICT (code) DO NOTHING;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Company-level PAYG eligibility signal + turnover declaration
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS payg_eligible BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS annual_turnover_cents BIGINT;  -- null = undeclared


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. `flow_bundles` — global catalogue of purchasable packs
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS flow_bundles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  flows         INT NOT NULL CHECK (flows > 0),
  price_cents   INT NOT NULL CHECK (price_cents >= 0),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  display_order INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_flow_bundles_active_order
  ON flow_bundles (display_order)
  WHERE is_active = true;

DROP TRIGGER IF EXISTS trg_flow_bundles_updated_at ON flow_bundles;
CREATE TRIGGER trg_flow_bundles_updated_at
  BEFORE UPDATE ON flow_bundles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Seed the four spec bundles.  R0.10 per Flow (10 cents).
INSERT INTO flow_bundles (name, flows, price_cents, display_order) VALUES
  ('Micro',   100,  1000, 1),
  ('Small',   500,  5000, 2),
  ('Medium', 1500, 15000, 3),
  ('Large',  2500, 25000, 4)
ON CONFLICT DO NOTHING;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. `flow_wallet` — one row per PAYG company
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS flow_wallet (
  company_id            UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  balance_flows         INT NOT NULL DEFAULT 0 CHECK (balance_flows >= 0),
  auto_topup_enabled    BOOLEAN NOT NULL DEFAULT false,
  auto_topup_bundle_id  UUID REFERENCES flow_bundles(id),
  payment_method_token  TEXT,
  nudge_level           TEXT NOT NULL DEFAULT 'none'
                          CHECK (nudge_level IN ('none','yellow','orange','red')),
  month_flows_used      INT NOT NULL DEFAULT 0 CHECK (month_flows_used >= 0),
  month_reset_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_flow_wallet_updated_at ON flow_wallet;
CREATE TRIGGER trg_flow_wallet_updated_at
  BEFORE UPDATE ON flow_wallet
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. `flow_ledger` — append-only audit log.  Every balance change writes a row.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS flow_ledger (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type           TEXT NOT NULL CHECK (type IN ('purchase','debit','refund','admin_adjustment')),
  flows          INT NOT NULL CHECK (flows <> 0),   -- positive = credit, negative = debit
  balance_after  INT NOT NULL CHECK (balance_after >= 0),
  operation_code TEXT,              -- e.g. 'bank.allocate', 'invoice.create', 'afs.generate'
  reference_id   UUID,              -- FK target is polymorphic — no constraint
  reason         TEXT,              -- human note for admin_adjustment entries
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_flow_ledger_company_recent
  ON flow_ledger (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_flow_ledger_month_sum
  ON flow_ledger (company_id, created_at)
  WHERE type = 'debit';

-- Append-only guard — mutations should RAISE rather than silently succeed.
CREATE OR REPLACE FUNCTION flow_ledger_block_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'flow_ledger is append-only — % is not permitted', TG_OP;
END $$;

DROP TRIGGER IF EXISTS trg_flow_ledger_no_update ON flow_ledger;
CREATE TRIGGER trg_flow_ledger_no_update
  BEFORE UPDATE OR DELETE ON flow_ledger
  FOR EACH ROW EXECUTE FUNCTION flow_ledger_block_mutation();


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. `flow_purchases` — payment records (v1: admin-recorded; v2: Stitch)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS flow_purchases (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bundle_id        UUID NOT NULL REFERENCES flow_bundles(id),
  flows            INT NOT NULL CHECK (flows > 0),
  price_cents      INT NOT NULL CHECK (price_cents >= 0),
  payment_method   TEXT NOT NULL DEFAULT 'admin_recorded',
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','succeeded','failed')),
  auto_triggered   BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_flow_purchases_company_recent
  ON flow_purchases (company_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_flow_purchases_updated_at ON flow_purchases;
CREATE TRIGGER trg_flow_purchases_updated_at
  BEFORE UPDATE ON flow_purchases
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ─────────────────────────────────────────────────────────────────────────────
-- 7. RLS — defence-in-depth for the three tenant-scoped tables
--    (`flow_bundles` is global; access gated by admin endpoints, not RLS)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE flow_wallet    ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_wallet    FORCE  ROW LEVEL SECURITY;
ALTER TABLE flow_ledger    ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_ledger    FORCE  ROW LEVEL SECURITY;
ALTER TABLE flow_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_purchases FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON flow_wallet;
CREATE POLICY tenant_isolation ON flow_wallet FOR ALL TO app_user
  USING (company_id IN (
    SELECT company_id FROM company_users WHERE user_id = auth.uid()
  ))
  WITH CHECK (company_id = app.current_company_id());

DROP POLICY IF EXISTS tenant_isolation ON flow_ledger;
CREATE POLICY tenant_isolation ON flow_ledger FOR ALL TO app_user
  USING (company_id IN (
    SELECT company_id FROM company_users WHERE user_id = auth.uid()
  ))
  WITH CHECK (company_id = app.current_company_id());

DROP POLICY IF EXISTS tenant_isolation ON flow_purchases;
CREATE POLICY tenant_isolation ON flow_purchases FOR ALL TO app_user
  USING (company_id IN (
    SELECT company_id FROM company_users WHERE user_id = auth.uid()
  ))
  WITH CHECK (company_id = app.current_company_id());

-- flow_bundles is read-only to tenants (admin manages via BYPASSRLS).
ALTER TABLE flow_bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_bundles FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bundles_read_all   ON flow_bundles;
DROP POLICY IF EXISTS bundles_no_tenant_writes ON flow_bundles;

CREATE POLICY bundles_read_all ON flow_bundles FOR SELECT TO app_user
  USING (true);

-- Block tenant writes; admin uses migration_admin/BYPASSRLS.
CREATE POLICY bundles_no_tenant_writes ON flow_bundles FOR ALL TO app_user
  USING (false) WITH CHECK (false);


-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Grants (default privileges from mig 348 already grant to app_user, but
--    be explicit for the four new tables so a fresh-clone DB applies the same)
-- ─────────────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE            ON flow_wallet    TO app_user;
GRANT SELECT, INSERT                     ON flow_ledger    TO app_user;  -- append-only
GRANT SELECT, INSERT, UPDATE            ON flow_purchases TO app_user;
GRANT SELECT                             ON flow_bundles   TO app_user;

COMMIT;
