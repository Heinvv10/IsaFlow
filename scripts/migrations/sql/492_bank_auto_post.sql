-- 492_bank_auto_post.sql
-- Confidence Auto-Post (UI-modernization Phase 3, increment 2).
-- Per-company opt-in gate + run-level audit for silent JE auto-posting.
-- Retrofits PRD-05 provisional posting under the same gate: with no settings
-- row a company is DISABLED, so provisional auto-posting switches OFF for every
-- company at deploy until someone opts in. This is the intended behavior change.

CREATE TABLE IF NOT EXISTS bank_auto_post_settings (
  company_id     UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  min_confidence NUMERIC(3,2) NOT NULL DEFAULT 0.90,
  amount_cap     NUMERIC(14,2) NOT NULL DEFAULT 10000,  -- 0 = no cap
  updated_by     UUID,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bank_auto_post_runs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source         TEXT NOT NULL CHECK (source IN ('import','categorization','manual')),
  min_confidence NUMERIC(3,2) NOT NULL,   -- snapshot at run time
  amount_cap     NUMERIC(14,2) NOT NULL,  -- snapshot at run time
  posted_count   INTEGER NOT NULL DEFAULT 0,
  total_amount   NUMERIC(14,2) NOT NULL DEFAULT 0,  -- sum of |amount|
  created_by     UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  undone_at      TIMESTAMPTZ,
  undone_by      UUID
);
CREATE INDEX IF NOT EXISTS idx_bapr_company ON bank_auto_post_runs(company_id, created_at DESC);

ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS auto_post_run_id UUID REFERENCES bank_auto_post_runs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_bt_auto_post_run ON bank_transactions(auto_post_run_id)
  WHERE auto_post_run_id IS NOT NULL;
