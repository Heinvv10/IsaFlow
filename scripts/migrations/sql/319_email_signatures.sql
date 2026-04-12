-- Migration 318: Email signatures per document type
-- Adds optional HTML signature fields to the companies table.
-- Signatures are appended below the email body when sending documents.
-- Supported document types: invoice, quote, statement, credit_note, sales_order, recurring_invoice

ALTER TABLE companies ADD COLUMN IF NOT EXISTS invoice_email_signature TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS quote_email_signature TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS statement_email_signature TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS credit_note_email_signature TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS sales_order_email_signature TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS recurring_invoice_email_signature TEXT;

-- Also add subject/body for the three new document types (credit note, sales order, recurring invoice)
ALTER TABLE companies ADD COLUMN IF NOT EXISTS credit_note_email_subject TEXT DEFAULT 'Credit Note {number} from {company}';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS credit_note_email_body TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS sales_order_email_subject TEXT DEFAULT 'Sales Order {number} from {company}';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS sales_order_email_body TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS recurring_invoice_email_subject TEXT DEFAULT 'Invoice {number} from {company}';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS recurring_invoice_email_body TEXT;
