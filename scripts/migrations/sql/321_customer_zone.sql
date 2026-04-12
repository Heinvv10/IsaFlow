-- Migration 320: Customer Zone — portal configuration columns on companies
-- Adds self-service portal settings to the companies table.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS portal_display_name VARCHAR(100);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS portal_tagline VARCHAR(200);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS portal_mode VARCHAR(20) NOT NULL DEFAULT 'full' CHECK (portal_mode IN ('full','invoices_only','statements_only'));
ALTER TABLE companies ADD COLUMN IF NOT EXISTS portal_show_account_balance BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS portal_show_transaction_history BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS portal_allow_payments BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS portal_payment_instructions TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS portal_welcome_message TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS portal_primary_color VARCHAR(7);
