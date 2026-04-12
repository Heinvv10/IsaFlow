-- Migration 315: User Defined Fields (UDFs) and Regional Settings extensions

-- ── UDF Definitions ──────────────────────────────────────────────────────────
-- Stores the label/type configuration for up to 12 UDFs per entity type per company
CREATE TABLE IF NOT EXISTS company_udf_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  entity_type VARCHAR(30) NOT NULL, -- 'customer', 'supplier', 'invoice', 'item'
  field_number INT NOT NULL,        -- 1-12
  field_label VARCHAR(100) NOT NULL,
  field_type VARCHAR(20) NOT NULL DEFAULT 'text', -- 'text', 'number', 'date', 'boolean', 'select'
  field_options TEXT,               -- comma-separated options for 'select' type
  is_required BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, entity_type, field_number)
);

CREATE INDEX IF NOT EXISTS idx_udf_company
  ON company_udf_definitions(company_id, entity_type);

-- ── UDF Values ───────────────────────────────────────────────────────────────
-- Stores actual UDF values per entity record
CREATE TABLE IF NOT EXISTS entity_udf_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  entity_type VARCHAR(30) NOT NULL,
  entity_id UUID NOT NULL,
  field_number INT NOT NULL,
  value TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, entity_type, entity_id, field_number)
);

CREATE INDEX IF NOT EXISTS idx_udfv_entity
  ON entity_udf_values(company_id, entity_type, entity_id);

-- ── Regional Settings extensions on companies table ──────────────────────────
-- invoice_logo_position supplements existing logo_position (which is for docs generally)
ALTER TABLE companies ADD COLUMN IF NOT EXISTS invoice_logo_position VARCHAR(20) DEFAULT 'top-right';
-- rounding_method: 'half-up' (standard) or 'half-even' (banker's rounding)
ALTER TABLE companies ADD COLUMN IF NOT EXISTS rounding_method VARCHAR(20) DEFAULT 'half-up';
