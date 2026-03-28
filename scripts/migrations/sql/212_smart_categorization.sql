-- ── Smart Categorization Patterns ────────────────────────────────────────────
-- Learned and system-seeded patterns for AI bank transaction categorization

CREATE TABLE IF NOT EXISTS categorization_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern TEXT NOT NULL,
  match_type TEXT NOT NULL DEFAULT 'contains', -- contains, starts_with, regex
  gl_account_id UUID REFERENCES gl_accounts(id),
  category TEXT,
  vat_code TEXT DEFAULT 'standard',
  confidence NUMERIC(3,2) DEFAULT 0.80,
  usage_count INTEGER DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  source TEXT DEFAULT 'learned' -- learned, manual, system
);

CREATE INDEX IF NOT EXISTS idx_cp_pattern ON categorization_patterns(pattern);
CREATE INDEX IF NOT EXISTS idx_cp_source ON categorization_patterns(source);

-- Add confidence column to bank_transactions for smart categorization
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS suggested_confidence NUMERIC(3,2);

-- Seed common SA merchant patterns
INSERT INTO categorization_patterns (pattern, match_type, category, vat_code, confidence, source) VALUES
('WOOLWORTHS', 'contains', 'Groceries & Supplies', 'standard', 0.90, 'system'),
('PICK N PAY', 'contains', 'Groceries & Supplies', 'standard', 0.90, 'system'),
('CHECKERS', 'contains', 'Groceries & Supplies', 'standard', 0.90, 'system'),
('SPAR', 'contains', 'Groceries & Supplies', 'standard', 0.90, 'system'),
('ENGEN', 'contains', 'Fuel & Transport', 'standard', 0.90, 'system'),
('SHELL', 'contains', 'Fuel & Transport', 'standard', 0.90, 'system'),
('SASOL', 'contains', 'Fuel & Transport', 'standard', 0.90, 'system'),
('BP ', 'contains', 'Fuel & Transport', 'standard', 0.90, 'system'),
('TAKEALOT', 'contains', 'Office Supplies', 'standard', 0.85, 'system'),
('AMAZON', 'contains', 'Software & Subscriptions', 'zero', 0.80, 'system'),
('GOOGLE', 'contains', 'Software & Subscriptions', 'zero', 0.80, 'system'),
('MICROSOFT', 'contains', 'Software & Subscriptions', 'zero', 0.80, 'system'),
('MTN', 'contains', 'Telecommunications', 'standard', 0.90, 'system'),
('VODACOM', 'contains', 'Telecommunications', 'standard', 0.90, 'system'),
('TELKOM', 'contains', 'Telecommunications', 'standard', 0.90, 'system'),
('ESKOM', 'contains', 'Utilities', 'standard', 0.90, 'system'),
('CITY OF', 'contains', 'Utilities', 'exempt', 0.85, 'system'),
('MUNICIPALITY', 'contains', 'Utilities', 'exempt', 0.85, 'system'),
('SARS', 'contains', 'Tax Payments', 'exempt', 0.95, 'system'),
('SALARY', 'contains', 'Salaries & Wages', 'exempt', 0.90, 'system'),
('PAYROLL', 'contains', 'Salaries & Wages', 'exempt', 0.90, 'system'),
('UBER', 'contains', 'Transport', 'standard', 0.85, 'system'),
('BOLT', 'contains', 'Transport', 'standard', 0.85, 'system'),
('DISCOVERY', 'contains', 'Insurance', 'exempt', 0.85, 'system'),
('OLD MUTUAL', 'contains', 'Insurance', 'exempt', 0.85, 'system'),
('SANLAM', 'contains', 'Insurance', 'exempt', 0.85, 'system'),
('FNB', 'starts_with', 'Bank Charges', 'exempt', 0.80, 'system'),
('SERVICE FEE', 'contains', 'Bank Charges', 'exempt', 0.90, 'system'),
('MONTHLY FEE', 'contains', 'Bank Charges', 'exempt', 0.90, 'system'),
('INTEREST', 'contains', 'Interest', 'exempt', 0.85, 'system')
ON CONFLICT DO NOTHING;
