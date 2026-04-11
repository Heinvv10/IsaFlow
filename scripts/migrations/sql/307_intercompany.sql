-- ============================================================================
-- 307: Intercompany Consolidations
-- Lightweight parent-child company relationships and elimination entries
-- that complement the existing company_groups/company_group_members system.
-- ============================================================================

BEGIN;

-- ── 1. Direct parent-child company relationships ──────────────────────────────
CREATE TABLE IF NOT EXISTS company_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_company_id UUID NOT NULL REFERENCES companies(id),
  child_company_id  UUID NOT NULL REFERENCES companies(id),
  relationship_type VARCHAR(30) NOT NULL DEFAULT 'subsidiary', -- subsidiary, branch, associate
  ownership_percent NUMERIC(5,2) DEFAULT 100.00,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(parent_company_id, child_company_id)
);

CREATE INDEX IF NOT EXISTS idx_company_relationships_parent ON company_relationships(parent_company_id);
CREATE INDEX IF NOT EXISTS idx_company_relationships_child  ON company_relationships(child_company_id);

-- ── 2. Intercompany elimination entries ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS intercompany_eliminations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_company_id UUID NOT NULL REFERENCES companies(id), -- the parent viewing the consolidation
  from_company_id  UUID NOT NULL REFERENCES companies(id),
  to_company_id    UUID NOT NULL REFERENCES companies(id),
  period_start     DATE NOT NULL,
  period_end       DATE NOT NULL,
  elimination_type VARCHAR(50) NOT NULL, -- receivable_payable, revenue_expense, investment_equity
  amount           NUMERIC(15,2) NOT NULL,
  description      TEXT,
  created_by       UUID,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_interco_eliminations_group_period
  ON intercompany_eliminations(group_company_id, period_start, period_end);

COMMIT;
