-- Migration 266: Admin Platform — Extend companies and users tables
-- Adds billing, plan linkage, suspension, and status tracking columns.
-- All additions use IF NOT EXISTS so re-running is safe.
-- NOTE: users already has last_login and is_active — not duplicated here.

-- Companies: plan linkage, billing contacts, suspension, and Stripe reference
ALTER TABLE companies ADD COLUMN IF NOT EXISTS plan_id UUID REFERENCES plans(id);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS suspended_reason TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS billing_email VARCHAR(255);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS billing_contact VARCHAR(255);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- Users: richer status, IP tracking, login counter, and suspension
-- status supplements the existing boolean is_active with granular states
ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ip VARCHAR(45);
ALTER TABLE users ADD COLUMN IF NOT EXISTS login_count INT DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_reason TEXT;
