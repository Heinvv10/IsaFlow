-- Migration 261: Admin Platform — Plans table
-- Stores subscription plan definitions for the ISAFlow Admin Platform.
-- Plans control feature access and billing amounts per company.

CREATE TABLE IF NOT EXISTS plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  monthly_price_cents INT NOT NULL DEFAULT 0,
  annual_price_cents INT NOT NULL DEFAULT 0,
  currency VARCHAR(3) DEFAULT 'ZAR',
  features JSONB DEFAULT '{}',
  limits JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  display_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Starter: R299/mo, R2990/yr — 1 user, core accounting + invoicing
INSERT INTO plans (code, name, description, monthly_price_cents, annual_price_cents, currency, limits, display_order)
VALUES (
  'starter',
  'Starter',
  'Core accounting and invoicing for sole traders and micro businesses.',
  29900,
  299000,
  'ZAR',
  '{"max_users": 1, "max_companies": 1}',
  1
)
ON CONFLICT (code) DO NOTHING;

-- Professional: R599/mo, R5990/yr — 5 users, + payroll, multi-company, bank feeds, document capture
INSERT INTO plans (code, name, description, monthly_price_cents, annual_price_cents, currency, limits, display_order)
VALUES (
  'professional',
  'Professional',
  'Full-featured accounting with payroll, bank feeds, and document capture for growing businesses.',
  59900,
  599000,
  'ZAR',
  '{"max_users": 5, "max_companies": 3}',
  2
)
ON CONFLICT (code) DO NOTHING;

-- Enterprise: R1499/mo, R14990/yr — unlimited users, + API, custom reports, priority support
INSERT INTO plans (code, name, description, monthly_price_cents, annual_price_cents, currency, limits, display_order)
VALUES (
  'enterprise',
  'Enterprise',
  'Unlimited users, API access, custom reports, group consolidation, and priority support.',
  149900,
  1499000,
  'ZAR',
  '{"max_users": null, "max_companies": null}',
  3
)
ON CONFLICT (code) DO NOTHING;
