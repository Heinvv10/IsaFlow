-- 1041: the dark feature flag `trial_self_serve_upgrade` (self-serve upgrade from trial ships INERT). Forward only: one feature_flags row.
--
-- WHAT IT GATES (src/modules/billing/services/selfServeUpgradeGate.ts, `hasFeature`: a company override first, then is_global, then plan
-- membership):
--   * GET /api/billing/upgrade/status, POST /api/billing/upgrade/start and POST /api/billing/upgrade/convert: with the flag off for the
--     company each answers 404, for every role, before anything is read or written;
--   * the Settings > Billing > "Upgrade from trial" nav link (flagNav.ts FLAGGED_SURFACES) and the upgrade page, which shows nothing
--     without the flag.
-- WHAT IT DOES NOT GATE: the admin "Convert to Paid" (/api/admin/trials/convert), the admin mandate create / verify / revoke routes, the
-- Paystack webhook and the subscription charge cron.
--
-- DARK: is_global false and in no plan (no plan_features row), so every company, the production tenants included, has it OFF until a
-- platform admin sets a company_feature_overrides row (the admin features page) for that company.
-- No new table, so no new RLS policy.

INSERT INTO feature_flags (code, name, description, is_global)
VALUES (
  'trial_self_serve_upgrade',
  'Billing: self-serve upgrade from trial',
  'A company owner on a trial picks a plan, authorises a Paystack mandate and converts their own company to the paid plan in the app. Dark: enabled per company by override.',
  false
)
ON CONFLICT (code) DO NOTHING;

-- Rollback (by hand; this repo stores no down migrations):
--   DELETE FROM company_feature_overrides
--    WHERE feature_id IN (SELECT id FROM feature_flags WHERE code = 'trial_self_serve_upgrade');
--   DELETE FROM feature_flags WHERE code = 'trial_self_serve_upgrade';
