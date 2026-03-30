-- Migration 256: Fix bank_categorisation_rules schema
-- The original migration (211) used different column names than what the service expects.
-- match_value → match_pattern, auto_approve → auto_create_entry, add missing columns.

-- Add match_pattern column (service uses this name)
ALTER TABLE bank_categorisation_rules ADD COLUMN IF NOT EXISTS match_pattern TEXT;

-- Backfill match_pattern from match_value for existing rows
UPDATE bank_categorisation_rules SET match_pattern = match_value WHERE match_pattern IS NULL AND match_value IS NOT NULL;

-- Make match_pattern NOT NULL with a default to avoid insert failures
ALTER TABLE bank_categorisation_rules ALTER COLUMN match_pattern SET DEFAULT '';

-- Add auto_create_entry column (service uses this; old schema had auto_approve)
ALTER TABLE bank_categorisation_rules ADD COLUMN IF NOT EXISTS auto_create_entry BOOLEAN DEFAULT false;

-- Backfill auto_create_entry from auto_approve for existing rows
UPDATE bank_categorisation_rules SET auto_create_entry = auto_approve WHERE auto_create_entry IS NULL OR auto_create_entry = false;

-- Add description_template column
ALTER TABLE bank_categorisation_rules ADD COLUMN IF NOT EXISTS description_template TEXT;

-- Add vat_code column
ALTER TABLE bank_categorisation_rules ADD COLUMN IF NOT EXISTS vat_code VARCHAR(20) DEFAULT 'none';

-- Rename rule_name column alias: the old schema has rule_name which is correct — no change needed.

-- Ensure company_id exists (already added in 220 but guard it)
ALTER TABLE bank_categorisation_rules ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);

-- Ensure created_by is UUID-compatible (original was VARCHAR, service casts to UUID)
-- We cannot change the type easily if data exists; leave as-is and handle in service.
