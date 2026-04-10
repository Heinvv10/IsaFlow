-- Fix bank_categorisation_rules columns to match service expectations
ALTER TABLE bank_categorisation_rules RENAME COLUMN match_value TO match_pattern;
ALTER TABLE bank_categorisation_rules ADD COLUMN IF NOT EXISTS description_template TEXT;
ALTER TABLE bank_categorisation_rules ADD COLUMN IF NOT EXISTS auto_create_entry BOOLEAN DEFAULT false;
ALTER TABLE bank_categorisation_rules ADD COLUMN IF NOT EXISTS vat_code TEXT DEFAULT 'none';
