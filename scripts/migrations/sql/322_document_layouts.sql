-- Migration 320: Document layout preferences per company
ALTER TABLE companies ADD COLUMN IF NOT EXISTS invoice_layout VARCHAR(20) NOT NULL DEFAULT 'classic';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS quote_layout   VARCHAR(20) NOT NULL DEFAULT 'classic';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS statement_layout VARCHAR(20) NOT NULL DEFAULT 'classic';
