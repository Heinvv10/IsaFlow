-- Migration 297: Multi-currency support
-- Fills gaps in currencies / exchange_rates tables and seeds global currencies.
-- All DDL uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS guards.

-- ── 1. currencies: relax company_id to allow global (system) currency rows ───

ALTER TABLE currencies ALTER COLUMN company_id DROP NOT NULL;

-- Add decimal_places if missing
ALTER TABLE currencies ADD COLUMN IF NOT EXISTS decimal_places INTEGER DEFAULT 2;

-- Seed global (non-company-scoped) currency rows
INSERT INTO currencies (code, name, symbol, is_base, is_active, decimal_places)
VALUES
  ('ZAR', 'South African Rand',  'R',   true,  true, 2),
  ('USD', 'US Dollar',            '$',   false, true, 2),
  ('EUR', 'Euro',                 '€',   false, true, 2),
  ('GBP', 'British Pound',        '£',   false, true, 2),
  ('BWP', 'Botswana Pula',        'P',   false, true, 2),
  ('ZWL', 'Zimbabwe Dollar',      'Z$',  false, true, 2),
  ('NAD', 'Namibian Dollar',      'N$',  false, true, 2),
  ('MUR', 'Mauritian Rupee',      '₨',   false, true, 2),
  ('KES', 'Kenyan Shilling',      'KSh', false, true, 2),
  ('NGN', 'Nigerian Naira',       '₦',   false, true, 2)
ON CONFLICT DO NOTHING;

-- ── 2. exchange_rates: add missing columns ────────────────────────────────────

ALTER TABLE exchange_rates ADD COLUMN IF NOT EXISTS source     VARCHAR(50) DEFAULT 'manual';
-- created_by stored as VARCHAR to match users.id type (character varying)
ALTER TABLE exchange_rates ADD COLUMN IF NOT EXISTS created_by VARCHAR(255);

-- Unique index to support ON CONFLICT in setExchangeRate()
CREATE UNIQUE INDEX IF NOT EXISTS uq_exchange_rates_company_pair_date
  ON exchange_rates (company_id, from_currency, to_currency, effective_date);

-- ── 3. companies: add functional_currency ────────────────────────────────────

ALTER TABLE companies ADD COLUMN IF NOT EXISTS functional_currency VARCHAR(3) DEFAULT 'ZAR';
