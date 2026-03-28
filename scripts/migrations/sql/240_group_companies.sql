-- ============================================================================
-- 240: Group Company / Consolidated Reporting
-- Enables multi-entity group structures, intercompany tracking,
-- unified group chart of accounts, and consolidated reporting.
-- ============================================================================

BEGIN;

-- ──────────────────────────────────────────────────────────────────────────────
-- 1. Company Groups — defines a holding/subsidiary group
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS company_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,                              -- "ABC Holdings Group"
  holding_company_id UUID REFERENCES companies(id),
  default_currency TEXT DEFAULT 'ZAR',
  financial_year_start INTEGER DEFAULT 3,          -- month (1-12)
  is_active BOOLEAN DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_company_groups_holding ON company_groups(holding_company_id);

-- ──────────────────────────────────────────────────────────────────────────────
-- 2. Group Members — links companies to groups with ownership details
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS company_group_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES company_groups(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id),
  ownership_pct NUMERIC(5,2) DEFAULT 100.00,       -- % held by holding company
  consolidation_method TEXT NOT NULL DEFAULT 'full', -- full, proportionate, equity
  is_holding BOOLEAN DEFAULT false,                  -- true if this is the holding company
  joined_date DATE NOT NULL DEFAULT CURRENT_DATE,
  left_date DATE,                                    -- for de-grouping tracking (s45 6yr rule)
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(group_id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_group_members_group ON company_group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_company ON company_group_members(company_id);

-- ──────────────────────────────────────────────────────────────────────────────
-- 3. Group Chart of Accounts — unified COA for consolidated reporting
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS group_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES company_groups(id) ON DELETE CASCADE,
  account_code TEXT NOT NULL,
  account_name TEXT NOT NULL,
  account_type TEXT NOT NULL,                       -- asset, liability, equity, revenue, expense
  account_subtype TEXT,                             -- bank, receivable, cost_of_sales, etc.
  parent_account_id UUID REFERENCES group_accounts(id),
  normal_balance TEXT NOT NULL DEFAULT 'debit',     -- debit, credit
  level INTEGER DEFAULT 1,
  display_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(group_id, account_code)
);

CREATE INDEX IF NOT EXISTS idx_group_accounts_group ON group_accounts(group_id);

-- ──────────────────────────────────────────────────────────────────────────────
-- 4. COA Mappings — maps each company's accounts to group accounts
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS group_coa_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES company_groups(id) ON DELETE CASCADE,
  group_account_id UUID NOT NULL REFERENCES group_accounts(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id),
  company_account_id UUID NOT NULL REFERENCES gl_accounts(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(group_id, company_id, company_account_id)
);

CREATE INDEX IF NOT EXISTS idx_group_coa_map_group ON group_coa_mappings(group_id);
CREATE INDEX IF NOT EXISTS idx_group_coa_map_company ON group_coa_mappings(company_id);

-- ──────────────────────────────────────────────────────────────────────────────
-- 5. Intercompany Transactions — track and reconcile between entities
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS intercompany_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES company_groups(id) ON DELETE CASCADE,
  source_company_id UUID NOT NULL REFERENCES companies(id),
  target_company_id UUID NOT NULL REFERENCES companies(id),
  source_journal_entry_id UUID REFERENCES gl_journal_entries(id),
  target_journal_entry_id UUID REFERENCES gl_journal_entries(id),
  transaction_type TEXT NOT NULL,                   -- sale, purchase, loan, dividend, mgmt_fee, transfer
  amount NUMERIC(15,2) NOT NULL,
  currency TEXT DEFAULT 'ZAR',
  description TEXT,
  transaction_date DATE NOT NULL,
  match_status TEXT NOT NULL DEFAULT 'unmatched',   -- unmatched, matched, partial, variance
  variance_amount NUMERIC(15,2) DEFAULT 0,
  matched_at TIMESTAMPTZ,
  matched_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_interco_tx_group ON intercompany_transactions(group_id);
CREATE INDEX IF NOT EXISTS idx_interco_tx_source ON intercompany_transactions(source_company_id);
CREATE INDEX IF NOT EXISTS idx_interco_tx_target ON intercompany_transactions(target_company_id);
CREATE INDEX IF NOT EXISTS idx_interco_tx_status ON intercompany_transactions(match_status);
CREATE INDEX IF NOT EXISTS idx_interco_tx_date ON intercompany_transactions(transaction_date);

-- ──────────────────────────────────────────────────────────────────────────────
-- 6. Consolidation Adjustments — elimination journals for consolidated reports
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS consolidation_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES company_groups(id) ON DELETE CASCADE,
  adjustment_number TEXT,                           -- ELIM-YYYY-NNNNN
  adjustment_type TEXT NOT NULL,                    -- interco_revenue, interco_balance, unrealised_profit, nci, currency_translation, goodwill
  description TEXT,
  fiscal_period_id UUID,                            -- period this adjustment applies to
  period_start DATE,
  period_end DATE,
  status TEXT NOT NULL DEFAULT 'draft',             -- draft, posted, reversed
  lines JSONB NOT NULL DEFAULT '[]',                -- [{groupAccountId, debit, credit, description}]
  source_intercompany_id UUID REFERENCES intercompany_transactions(id),
  posted_by UUID,
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_consol_adj_group ON consolidation_adjustments(group_id);
CREATE INDEX IF NOT EXISTS idx_consol_adj_period ON consolidation_adjustments(period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_consol_adj_status ON consolidation_adjustments(status);

-- ──────────────────────────────────────────────────────────────────────────────
-- 7. Auto-number for consolidation adjustments
-- ──────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION generate_consolidation_adj_number()
RETURNS TRIGGER AS $$
DECLARE
  adj_year INT;
  next_seq INT;
BEGIN
  IF NEW.adjustment_number IS NOT NULL THEN
    RETURN NEW;
  END IF;
  adj_year := EXTRACT(YEAR FROM COALESCE(NEW.period_start, CURRENT_DATE));
  SELECT COALESCE(MAX(
    CAST(NULLIF(SPLIT_PART(adjustment_number, '-', 3), '') AS INT)
  ), 0) + 1 INTO next_seq
  FROM consolidation_adjustments
  WHERE group_id = NEW.group_id
    AND adjustment_number LIKE 'ELIM-' || adj_year || '-%';
  NEW.adjustment_number := 'ELIM-' || adj_year || '-' || LPAD(next_seq::TEXT, 5, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_consol_adj_number ON consolidation_adjustments;
CREATE TRIGGER trg_consol_adj_number
  BEFORE INSERT ON consolidation_adjustments
  FOR EACH ROW EXECUTE FUNCTION generate_consolidation_adj_number();

-- ──────────────────────────────────────────────────────────────────────────────
-- 8. Flag on gl_journal_entries for intercompany tagging
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE gl_journal_entries ADD COLUMN IF NOT EXISTS is_intercompany BOOLEAN DEFAULT false;
ALTER TABLE gl_journal_entries ADD COLUMN IF NOT EXISTS intercompany_company_id UUID REFERENCES companies(id);

CREATE INDEX IF NOT EXISTS idx_je_intercompany ON gl_journal_entries(is_intercompany) WHERE is_intercompany = true;

COMMIT;
