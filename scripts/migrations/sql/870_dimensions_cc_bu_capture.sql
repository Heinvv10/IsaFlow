-- 870: CC1 / CC2 / BU dimensions at capture (Phase 1 of the dimensions plan).
--
-- The canonical line dimensions are gl_journal_lines.cc1_id / cc2_id / bu_id
-- (migration 285): CC1 = FNO / client, CC2 = project (parent_id -> its CC1, or
-- -> a programme CC2 whose parent is the CC1), BU = function. Until now only
-- the journal line could carry them, so a bill, a customer invoice or a credit
-- note had nowhere to hold the judgement made at capture. This adds the slots
-- on the documents, the masters the derivation reads (customer FNO, bank/card
-- defaults, BU division, cost-centre aliases), the chart-of-accounts reporting
-- ladder, and the audit/undo tables for dimension-only back-tagging.
--
-- Every column is nullable and every table is new, so nothing existing moves:
-- no amount, account or date changes, and no row is backfilled.
--
-- apply-migrations.ts wraps the file in BEGIN/COMMIT; fail fast rather than
-- queue behind a long reader on the hot tables (gl_accounts, customers).
SET LOCAL lock_timeout = '5s';

-- ── Document line dimensions ───────────────────────────────────────────────
-- RESTRICT, like migration 660: a cost centre or BU a document names cannot be
-- deleted out from under it (costCentreUsageGuard maps the 23503 to a 400).
ALTER TABLE supplier_invoice_items
  ADD COLUMN IF NOT EXISTS cc1_id UUID REFERENCES cost_centres(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS cc2_id UUID REFERENCES cost_centres(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS bu_id  UUID REFERENCES business_units(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_sii_cc1 ON supplier_invoice_items(cc1_id) WHERE cc1_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sii_cc2 ON supplier_invoice_items(cc2_id) WHERE cc2_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sii_bu  ON supplier_invoice_items(bu_id)  WHERE bu_id  IS NOT NULL;

ALTER TABLE customer_invoice_items
  ADD COLUMN IF NOT EXISTS cc1_id UUID REFERENCES cost_centres(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS cc2_id UUID REFERENCES cost_centres(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS bu_id  UUID REFERENCES business_units(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_cii_cc1 ON customer_invoice_items(cc1_id) WHERE cc1_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cii_cc2 ON customer_invoice_items(cc2_id) WHERE cc2_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cii_bu  ON customer_invoice_items(bu_id)  WHERE bu_id  IS NOT NULL;

-- Credit notes have no line table in this schema (creditNotePdfBuilder.ts says
-- so): a note posts ONE revenue/expense line from its header, so the header is
-- the line the dimensions belong to.
ALTER TABLE credit_notes
  ADD COLUMN IF NOT EXISTS cc1_id UUID REFERENCES cost_centres(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS cc2_id UUID REFERENCES cost_centres(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS bu_id  UUID REFERENCES business_units(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_cn_cc1 ON credit_notes(cc1_id) WHERE cc1_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cn_cc2 ON credit_notes(cc2_id) WHERE cc2_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cn_bu  ON credit_notes(bu_id)  WHERE bu_id  IS NOT NULL;

-- ── Masters the derivation reads ───────────────────────────────────────────
-- Organisation ladder L2 (brief §5.2): Division is an attribute of the BU.
ALTER TABLE business_units ADD COLUMN IF NOT EXISTS division TEXT;

-- FNO on a revenue line comes from the customer, never from a project (§5.4).
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS default_cc1_id UUID REFERENCES cost_centres(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_customers_default_cc1 ON customers(default_cc1_id) WHERE default_cc1_id IS NOT NULL;

-- A bank account IS a gl_accounts row here (bank_transactions.bank_account_id
-- references gl_accounts(id); the separate bank_accounts table is unused by the
-- allocation path). Card spend takes its CC/BU from the card (brief §5.4) —
-- these are the card's defaults, read only for a bank-subtype account.
ALTER TABLE gl_accounts
  ADD COLUMN IF NOT EXISTS default_cc1_id UUID REFERENCES cost_centres(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS default_cc2_id UUID REFERENCES cost_centres(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS default_bu_id  UUID REFERENCES business_units(id) ON DELETE RESTRICT;

-- The account ladder (brief §5.1, wire diagram "Account" ladder L4..L1 plus the
-- cash class and capex/opex flag): attributes of the account, so they are
-- derived on every line and can never be typed on a transaction.
ALTER TABLE gl_accounts
  ADD COLUMN IF NOT EXISTS report_category TEXT,
  ADD COLUMN IF NOT EXISTS statement_line  TEXT,
  ADD COLUMN IF NOT EXISTS statement_group TEXT,
  ADD COLUMN IF NOT EXISTS report_class    TEXT,
  ADD COLUMN IF NOT EXISTS cash_class      TEXT,
  ADD COLUMN IF NOT EXISTS capex_opex      TEXT;

-- A COS line with no project is a warning by default; this turns it into a
-- block for capture paths once the company is ready (brief §10, warn-then-block).
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS require_project_on_cos BOOLEAN NOT NULL DEFAULT false;

-- ── Cost-centre aliases (brief §5.3: "an alias table, Spelling -> Project") ──
CREATE TABLE IF NOT EXISTS cost_centre_aliases (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  cost_centre_id   UUID NOT NULL REFERENCES cost_centres(id) ON DELETE CASCADE,
  alias            TEXT NOT NULL,
  -- lower(btrim()) with inner whitespace collapsed — computed by the service
  -- (costCentreAliasKey) so the lookup and the unique key are the same string.
  alias_normalized TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cost_centre_aliases_company_alias
  ON cost_centre_aliases(company_id, alias_normalized);
CREATE INDEX IF NOT EXISTS idx_cost_centre_aliases_cc ON cost_centre_aliases(cost_centre_id);

-- ── Dimension-only tagging: audit + undo (plan Phase 4, brief §8.4) ─────────
CREATE TABLE IF NOT EXISTS dimension_tag_batches (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  idempotency_key  TEXT NOT NULL,
  reason           TEXT,
  -- True when any line sat in a closed fiscal period: amounts never move, but
  -- the batch is a restatement of that period's analysis and is reported so.
  is_restatement   BOOLEAN NOT NULL DEFAULT false,
  line_count       INTEGER NOT NULL DEFAULT 0,
  -- users.id is a string in this schema (never ::UUID).
  created_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reversed_at      TIMESTAMPTZ,
  reversed_by      TEXT,
  reversal_reason  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dimension_tag_batches_key
  ON dimension_tag_batches(company_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_dimension_tag_batches_company
  ON dimension_tag_batches(company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS dimension_tag_batch_lines (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id           UUID NOT NULL REFERENCES dimension_tag_batches(id) ON DELETE CASCADE,
  company_id         UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  journal_line_id    UUID NOT NULL REFERENCES gl_journal_lines(id) ON DELETE CASCADE,
  old_cc1_id         UUID,
  old_cc2_id         UUID,
  old_bu_id          UUID,
  new_cc1_id         UUID,
  new_cc2_id         UUID,
  new_bu_id          UUID,
  -- brief §5.5 "blank is never a code": why a line is tagged (unallocated).
  unallocated_reason TEXT,
  period_closed      BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_dimension_tag_batch_lines_batch ON dimension_tag_batch_lines(batch_id);
CREATE INDEX IF NOT EXISTS idx_dimension_tag_batch_lines_line ON dimension_tag_batch_lines(journal_line_id);

-- Tenant RLS, as 853: enabled and forced BEFORE the grant; membership to read,
-- membership AND the active company to write.
ALTER TABLE cost_centre_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_centre_aliases FORCE ROW LEVEL SECURITY;
ALTER TABLE dimension_tag_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE dimension_tag_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE dimension_tag_batch_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE dimension_tag_batch_lines FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON cost_centre_aliases TO app_user, platform_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON dimension_tag_batches TO app_user, platform_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON dimension_tag_batch_lines TO app_user, platform_admin;
GRANT ALL ON cost_centre_aliases TO migration_admin;
GRANT ALL ON dimension_tag_batches TO migration_admin;
GRANT ALL ON dimension_tag_batch_lines TO migration_admin;

DROP POLICY IF EXISTS tenant_isolation ON cost_centre_aliases;
CREATE POLICY tenant_isolation ON cost_centre_aliases
  FOR ALL TO app_user
  USING (company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id IN (SELECT auth.user_companies()) AND company_id = app.current_company_id());

DROP POLICY IF EXISTS tenant_isolation ON dimension_tag_batches;
CREATE POLICY tenant_isolation ON dimension_tag_batches
  FOR ALL TO app_user
  USING (company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id IN (SELECT auth.user_companies()) AND company_id = app.current_company_id());

DROP POLICY IF EXISTS tenant_isolation ON dimension_tag_batch_lines;
CREATE POLICY tenant_isolation ON dimension_tag_batch_lines
  FOR ALL TO app_user
  USING (company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id IN (SELECT auth.user_companies()) AND company_id = app.current_company_id());
