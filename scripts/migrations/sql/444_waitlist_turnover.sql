-- Capture declared annual turnover at waitlist signup so we can route
-- micro enterprises (< R1M/year) onto the Pay-As-You-Go plan when they
-- are promoted to a real company at onboarding time.
--
-- Spec: docs/superpowers/specs/2026-04-19-payg-flows-pricing-design.md §3
-- Only populated for signup_type='direct' — bureaus (accountants) don't
-- declare their own practice turnover at this stage.

ALTER TABLE waitlist_signups
  ADD COLUMN IF NOT EXISTS annual_turnover_cents BIGINT;

COMMENT ON COLUMN waitlist_signups.annual_turnover_cents IS
  'Self-declared annual turnover in ZAR cents; null = undeclared. Seeds companies.annual_turnover_cents on promotion to real tenant. < R1M flags PAYG eligibility.';
