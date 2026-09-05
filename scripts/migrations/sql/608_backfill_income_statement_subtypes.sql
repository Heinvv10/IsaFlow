-- Migration 608: Backfill account_subtype on revenue/expense accounts that have none
-- 2026-09-05 | fix/account-subtype-at-creation
--
-- Root cause:
--   The Sage commit path never named account_subtype in its INSERT, and the
--   chart templates left several revenue/expense lines blank. The income
--   statement bands on account_subtype (cost_of_sales above gross profit,
--   everything else below), and treats NULL as "everything else". On Velocity
--   Fibre this filed R82.7m of direct costs under operating expenses and
--   reported a 96.6% gross margin. Net profit is unaffected: no journal moves.
--
-- Scope (three tenants, by company_id — never a platform-wide UPDATE):
--   Velocity Fibre  : 'COS - …' names → cost_of_sales; other expense →
--                     operating_expense; revenue → revenue. SYS-2 Purchases
--                     is Sage's cost-of-sales system account.
--   ISAFlow Demo    : 4310 Interest Received → revenue; the rest → operating_expense.
--   Brightsphere    : 5100 Cost of Sales → cost_of_sales; the rest → operating_expense.
--   Only rows with account_subtype IS NULL are touched, so re-running is a no-op.
--   Reserved subtypes (other_income, depreciation_expense, …) are deliberately
--   not assigned: they belong to each company's system accounts.
--
-- Creation-time gate shipped in the same PR (missingSubtypeError), so no new
-- NULL revenue/expense rows can be written after this runs.

DO $$
DECLARE
  v_velocity     UUID := '4a159669-2f50-46b5-a7b8-2e94dab3d495';
  v_demo         UUID := '00000000-0000-0000-0000-000000000001';
  v_brightsphere UUID := 'd27bac33-cdc0-4e58-bf6b-709c1597d41c';
  v_n            INTEGER;
  v_total        INTEGER := 0;
BEGIN
  -- Velocity: cost of sales first, so the generic expense update cannot take them.
  UPDATE gl_accounts SET account_subtype = 'cost_of_sales'
   WHERE company_id = v_velocity AND account_subtype IS NULL AND account_type = 'expense'
     AND (account_name ~* '^COS\s*-' OR account_code = 'SYS-2');
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  RAISE NOTICE 'Velocity cost_of_sales: %', v_n;

  UPDATE gl_accounts SET account_subtype = 'operating_expense'
   WHERE company_id = v_velocity AND account_subtype IS NULL AND account_type = 'expense';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  RAISE NOTICE 'Velocity operating_expense: %', v_n;

  UPDATE gl_accounts SET account_subtype = 'revenue'
   WHERE company_id = v_velocity AND account_subtype IS NULL AND account_type = 'revenue';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  RAISE NOTICE 'Velocity revenue: %', v_n;

  -- ISAFlow Demo
  UPDATE gl_accounts SET account_subtype = 'revenue'
   WHERE company_id = v_demo AND account_subtype IS NULL AND account_type = 'revenue';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  UPDATE gl_accounts SET account_subtype = 'operating_expense'
   WHERE company_id = v_demo AND account_subtype IS NULL AND account_type = 'expense';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  RAISE NOTICE 'Demo done';

  -- Brightsphere
  UPDATE gl_accounts SET account_subtype = 'cost_of_sales'
   WHERE company_id = v_brightsphere AND account_subtype IS NULL AND account_type = 'expense'
     AND account_code = '5100';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  UPDATE gl_accounts SET account_subtype = 'revenue'
   WHERE company_id = v_brightsphere AND account_subtype IS NULL AND account_type = 'revenue';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  UPDATE gl_accounts SET account_subtype = 'operating_expense'
   WHERE company_id = v_brightsphere AND account_subtype IS NULL AND account_type = 'expense';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;

  RAISE NOTICE 'Migration 608: % revenue/expense accounts subtyped', v_total;
END $$;
