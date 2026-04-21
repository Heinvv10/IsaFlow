-- 406_afs_statement_mapping.sql
-- AFS Statement Line Taxonomy & GL Account Mapping
-- Maps GL accounts to standardised BS/IS disclosure codes for AFS generation

-- ── afs_statement_lines ─────────────────────────────────────────────────────
-- Master list of statement line items (BS001-BS083, IS001-IS497).
-- One set per company so firms can customise labels / toggle visibility.

CREATE TABLE IF NOT EXISTS afs_statement_lines (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code            VARCHAR(10)  NOT NULL,          -- BS001, IS002, etc.
  section         VARCHAR(20)  NOT NULL           -- 'balance_sheet' | 'income_statement'
                    CHECK (section IN ('balance_sheet','income_statement')),
  label           TEXT         NOT NULL,          -- Display name on the statement
  parent_code     VARCHAR(10),                    -- For hierarchy (e.g. BS001 is parent of BS002-BS020)
  note_number     INTEGER,                        -- Links to disclosure note
  sort_order      INTEGER      NOT NULL DEFAULT 0,
  combine_group   VARCHAR(30),                    -- e.g. 'combine_interest' → aggregate into single note
  is_header       BOOLEAN      NOT NULL DEFAULT false,
  is_total        BOOLEAN      NOT NULL DEFAULT false,
  is_active       BOOLEAN      NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_afs_stmt_lines_company
  ON afs_statement_lines (company_id);
CREATE INDEX IF NOT EXISTS idx_afs_stmt_lines_section
  ON afs_statement_lines (company_id, section, sort_order);

-- ── afs_account_mappings ────────────────────────────────────────────────────
-- Links each GL account to exactly one AFS statement line code.

CREATE TABLE IF NOT EXISTS afs_account_mappings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  gl_account_id   UUID NOT NULL REFERENCES gl_accounts(id) ON DELETE CASCADE,
  afs_line_code   VARCHAR(10)  NOT NULL,          -- FK-like reference to afs_statement_lines.code
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, gl_account_id)
);

CREATE INDEX IF NOT EXISTS idx_afs_acct_map_company
  ON afs_account_mappings (company_id);
CREATE INDEX IF NOT EXISTS idx_afs_acct_map_line_code
  ON afs_account_mappings (company_id, afs_line_code);

-- ── updated_at trigger ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION afs_mapping_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_afs_statement_lines_updated
  BEFORE UPDATE ON afs_statement_lines
  FOR EACH ROW EXECUTE FUNCTION afs_mapping_updated_at();

CREATE TRIGGER trg_afs_account_mappings_updated
  BEFORE UPDATE ON afs_account_mappings
  FOR EACH ROW EXECUTE FUNCTION afs_mapping_updated_at();
