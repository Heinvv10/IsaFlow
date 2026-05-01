-- Wire Paystack plan codes onto the plans table.
--
-- Each ISAFlow plan tier maps to TWO Paystack plans (one per interval),
-- because Paystack plans are interval-locked. The subscription billing
-- service picks the right code based on subscriptions.billing_cycle.
--
-- Seeded values are TEST-mode plan codes from the ISAFlow Paystack
-- integration (created 2026-05-01). Live-mode codes will replace these
-- once Paystack approves the integration for live transactions — we'll
-- ship a follow-up data migration that overwrites the columns at that
-- point.

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS paystack_monthly_plan_code TEXT,
  ADD COLUMN IF NOT EXISTS paystack_annual_plan_code  TEXT;

COMMENT ON COLUMN plans.paystack_monthly_plan_code IS
  'Paystack PLN_ code used when billing_cycle=monthly. Test/live independent.';
COMMENT ON COLUMN plans.paystack_annual_plan_code IS
  'Paystack PLN_ code used when billing_cycle=annual. Test/live independent.';

-- Seed the test-mode codes onto existing rows. ON CONFLICT-safe via WHERE.
UPDATE plans SET
  paystack_monthly_plan_code = 'PLN_dxxqmod8el3die9',
  paystack_annual_plan_code  = 'PLN_l1an1vjxqnememv'
WHERE code = 'starter';

UPDATE plans SET
  paystack_monthly_plan_code = 'PLN_soudz1kn1aybe3l',
  paystack_annual_plan_code  = 'PLN_nbqe1fkhpfivenk'
WHERE code = 'professional';

UPDATE plans SET
  paystack_monthly_plan_code = 'PLN_fwskltmc52p1ndd',
  paystack_annual_plan_code  = 'PLN_pge6zbloukdyp6e'
WHERE code = 'enterprise';
