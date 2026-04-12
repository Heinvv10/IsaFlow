-- Migration 321: Netcash integration
-- Adds Netcash API credentials to companies and creates submission tracking table

ALTER TABLE companies ADD COLUMN IF NOT EXISTS netcash_service_key VARCHAR(100);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS netcash_payouts_key VARCHAR(100);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS netcash_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS netcash_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  submission_type VARCHAR(20) NOT NULL CHECK (submission_type IN ('eft_payment','debit_order')),
  batch_reference VARCHAR(100),
  total_amount_cents BIGINT NOT NULL,
  record_count INTEGER NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','submitted','processing','completed','failed')),
  netcash_response JSONB,
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by VARCHAR(100)
);

CREATE INDEX IF NOT EXISTS idx_netcash_company ON netcash_submissions(company_id);
CREATE INDEX IF NOT EXISTS idx_netcash_status ON netcash_submissions(company_id, status);
