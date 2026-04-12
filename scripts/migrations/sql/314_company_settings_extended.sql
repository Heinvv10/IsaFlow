-- Migration 314: Extended company settings
-- Adds aging bucket configuration, email template subjects/bodies,
-- and additional regional format settings to the companies table.

-- Aging configuration
ALTER TABLE companies ADD COLUMN IF NOT EXISTS aging_basis VARCHAR(20) DEFAULT 'due_date';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS aging_period_type VARCHAR(20) DEFAULT 'monthly';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS aging_bucket1_days INT DEFAULT 30;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS aging_bucket2_days INT DEFAULT 60;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS aging_bucket3_days INT DEFAULT 90;

-- Email template subjects & bodies (stored per document type on the company row)
ALTER TABLE companies ADD COLUMN IF NOT EXISTS invoice_email_subject TEXT DEFAULT 'Invoice {number} from {company}';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS invoice_email_body TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS quote_email_subject TEXT DEFAULT 'Quote {number} from {company}';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS quote_email_body TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS statement_email_subject TEXT DEFAULT 'Statement from {company}';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS statement_email_body TEXT;

-- Regional format settings (supplements existing currency_symbol / date_format)
ALTER TABLE companies ADD COLUMN IF NOT EXISTS decimal_separator CHAR(1) DEFAULT '.';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS thousands_separator CHAR(1) DEFAULT ',';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS decimal_places INT DEFAULT 2;
