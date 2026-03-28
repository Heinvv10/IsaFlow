-- Migration: Invoice Email Tracking
-- Adds email tracking columns to customer_invoices table

ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ;
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS email_sent_to TEXT;
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS email_message_id TEXT;
