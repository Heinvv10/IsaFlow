-- ── Bank transaction allocation columns and status fix ─────────────────────
-- Adds missing columns for smart categorisation, allocation tracking,
-- cost centre dimensions, and fixes the status constraint to include 'allocated'.

-- Smart categorisation columns
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS suggested_gl_account_id UUID;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS suggested_supplier_id UUID;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS suggested_client_id UUID;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS suggested_vat_code TEXT;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS suggested_category TEXT;

-- Allocation tracking
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS allocation_type TEXT;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS allocated_entity_name TEXT;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS linked_po_id UUID;

-- Cost centre dimensions
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS cc1_id UUID;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS cc2_id UUID;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS bu_id UUID;

-- Fix status constraint to include 'allocated'
ALTER TABLE bank_transactions DROP CONSTRAINT IF EXISTS bank_transactions_status_check;
ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_status_check
  CHECK (status IN ('imported', 'allocated', 'matched', 'reconciled', 'excluded'));
