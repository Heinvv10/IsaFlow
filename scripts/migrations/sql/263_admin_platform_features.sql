-- Migration 263: Admin Platform — Feature flags, plan features, and company overrides
-- feature_flags defines the available features in the system.
-- plan_features links features to plans (what each plan includes by default).
-- company_feature_overrides allows per-company exceptions above or below their plan.

CREATE TABLE IF NOT EXISTS feature_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(100) UNIQUE NOT NULL,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  is_global BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS plan_features (
  plan_id UUID NOT NULL REFERENCES plans(id),
  feature_id UUID NOT NULL REFERENCES feature_flags(id),
  PRIMARY KEY (plan_id, feature_id)
);

CREATE TABLE IF NOT EXISTS company_feature_overrides (
  company_id UUID NOT NULL REFERENCES companies(id),
  feature_id UUID NOT NULL REFERENCES feature_flags(id),
  enabled BOOLEAN NOT NULL,
  reason TEXT,
  set_by UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (company_id, feature_id)
);

-- -----------------------------------------------------------------------
-- Seed feature flags
-- -----------------------------------------------------------------------

-- Global features: included for every plan (and every company automatically)
INSERT INTO feature_flags (code, name, description, is_global)
VALUES
  ('core_accounting',    'Core Accounting',      'General ledger, chart of accounts, journal entries',    true),
  ('invoicing',          'Invoicing',             'Customer invoices, credit notes, and statements',       true),
  ('bank_recon',         'Bank Reconciliation',  'Manual bank reconciliation against bank statements',    true)
ON CONFLICT (code) DO NOTHING;

-- Non-global features: available only on specific plans
INSERT INTO feature_flags (code, name, description, is_global)
VALUES
  ('bank_feeds',            'Bank Feeds',             'Automatic bank transaction import via open-banking feeds', false),
  ('payroll',               'Payroll',                'Full payroll processing, PAYE, UIF, and SDL',              false),
  ('multi_company',         'Multi-Company',          'Manage more than one company under a single account',      false),
  ('document_capture',      'Document Capture',       'OCR-based upload and extraction of supplier invoices',     false),
  ('api_access',            'API Access',             'REST API access for integrations and automations',         false),
  ('custom_reports',        'Custom Reports',         'Build and save custom financial report layouts',           false),
  ('group_consolidation',   'Group Consolidation',    'Consolidated financial statements across group entities',  false),
  ('priority_support',      'Priority Support',       'Dedicated support queue with SLA guarantees',              false)
ON CONFLICT (code) DO NOTHING;

-- -----------------------------------------------------------------------
-- Link features to plans
-- -----------------------------------------------------------------------

-- Starter: global features only (core_accounting, invoicing, bank_recon)
-- Global features are implicit, but we still link them explicitly for clarity.
INSERT INTO plan_features (plan_id, feature_id)
SELECT p.id, f.id
FROM plans p, feature_flags f
WHERE p.code = 'starter'
  AND f.code IN ('core_accounting', 'invoicing', 'bank_recon')
ON CONFLICT DO NOTHING;

-- Professional: all Starter features + bank_feeds, payroll, multi_company, document_capture
INSERT INTO plan_features (plan_id, feature_id)
SELECT p.id, f.id
FROM plans p, feature_flags f
WHERE p.code = 'professional'
  AND f.code IN (
    'core_accounting', 'invoicing', 'bank_recon',
    'bank_feeds', 'payroll', 'multi_company', 'document_capture'
  )
ON CONFLICT DO NOTHING;

-- Enterprise: all Professional features + api_access, custom_reports, group_consolidation, priority_support
INSERT INTO plan_features (plan_id, feature_id)
SELECT p.id, f.id
FROM plans p, feature_flags f
WHERE p.code = 'enterprise'
  AND f.code IN (
    'core_accounting', 'invoicing', 'bank_recon',
    'bank_feeds', 'payroll', 'multi_company', 'document_capture',
    'api_access', 'custom_reports', 'group_consolidation', 'priority_support'
  )
ON CONFLICT DO NOTHING;
