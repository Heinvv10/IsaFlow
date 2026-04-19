-- Migration 362: Asset Period Ledger — dual-track per-period depreciation
-- Enables as-at-date FAR reporting (PRD-04 section 3.3 + section 6)

CREATE TABLE IF NOT EXISTS asset_period_ledger (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  asset_id                UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  period_date             DATE NOT NULL,        -- last day of the period
  yyyymm                  CHAR(6) NOT NULL,     -- e.g. '202201'

  -- Policy depreciation (IAS 16)
  policy_cost             NUMERIC(18,2) NOT NULL DEFAULT 0,
  policy_opening_acc_dep  NUMERIC(18,2) NOT NULL DEFAULT 0,
  policy_current_dep      NUMERIC(18,2) NOT NULL DEFAULT 0,
  policy_closing_acc_dep  NUMERIC(18,2) NOT NULL DEFAULT 0,
  policy_carrying_amount  NUMERIC(18,2) NOT NULL DEFAULT 0,
  policy_dep_rate         NUMERIC(8,6),

  -- Tax depreciation (SARS wear & tear)
  tax_cost                NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_opening_acc_dep     NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_current_dep         NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_closing_acc_dep     NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_carrying_amount     NUMERIC(18,2) NOT NULL DEFAULT 0,

  -- Deferred tax: (tax_carrying_amount − policy_carrying_amount) × deferred_tax_rate
  deferred_tax            NUMERIC(18,2),

  -- Disposal movement (populated when asset disposed in this period)
  disposal_proceeds       NUMERIC(18,2),
  policy_profit_loss      NUMERIC(18,2),
  tax_profit_loss         NUMERIC(18,2),

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (company_id, asset_id, yyyymm)
);

CREATE INDEX IF NOT EXISTS idx_apl_company_period  ON asset_period_ledger(company_id, yyyymm);
CREATE INDEX IF NOT EXISTS idx_apl_asset_period    ON asset_period_ledger(asset_id, yyyymm);
CREATE INDEX IF NOT EXISTS idx_apl_company_asset   ON asset_period_ledger(company_id, asset_id);
