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
--   Only rows with account_subtype IS NULL AND is_system_account = false are
--   touched, so re-running is a no-op and a system row still awaiting its role
--   (mig 605-607) is never stamped operating_expense. Reserved subtypes are
--   never assigned here; they belong to each company's system accounts.
--   The cost-of-sales predicate is the same one sageAccountSubtype.ts uses
--   ('COS' prefix or a Sage EX2xxx code in the name), so a re-import and this
--   backfill give one answer.
--
-- Post-conditions: RAISE EXCEPTION (rolling the block back) if any non-system
-- revenue/expense row on the three tenants is still NULL — the state this
-- file is responsible for. A Velocity cost-of-sales-named account carrying
-- some OTHER subtype is only a WARNING: this migration never touches a
-- non-NULL row, so a hand reclassification made before the deploy must not
-- abort it.
--
-- Creation and edit paths gained missingSubtypeError in the same PR, so no
-- non-system revenue/expense row can be written or cleared to NULL after this.

DO $$
DECLARE
  v_velocity     UUID := '4a159669-2f50-46b5-a7b8-2e94dab3d495';
  v_demo         UUID := '00000000-0000-0000-0000-000000000001';
  v_brightsphere UUID := 'd27bac33-cdc0-4e58-bf6b-709c1597d41c';
  v_n            INTEGER;
  v_total        INTEGER := 0;
  v_bad          INTEGER;
BEGIN
  -- Velocity: cost of sales first, so the generic expense update cannot take them.
  UPDATE gl_accounts SET account_subtype = 'cost_of_sales'
   WHERE company_id = v_velocity AND account_subtype IS NULL AND is_system_account = false
     AND account_type = 'expense'
     AND (account_name ~* '^COS\M' OR account_name ~* '\mEX2\d{3}\M' OR account_code = 'SYS-2');
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  RAISE NOTICE 'Velocity cost_of_sales: %', v_n;

  UPDATE gl_accounts SET account_subtype = 'operating_expense'
   WHERE company_id = v_velocity AND account_subtype IS NULL AND is_system_account = false AND account_type = 'expense';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  RAISE NOTICE 'Velocity operating_expense: %', v_n;

  UPDATE gl_accounts SET account_subtype = 'revenue'
   WHERE company_id = v_velocity AND account_subtype IS NULL AND is_system_account = false AND account_type = 'revenue';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  RAISE NOTICE 'Velocity revenue: %', v_n;

  -- ISAFlow Demo
  UPDATE gl_accounts SET account_subtype = 'revenue'
   WHERE company_id = v_demo AND account_subtype IS NULL AND is_system_account = false AND account_type = 'revenue';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  UPDATE gl_accounts SET account_subtype = 'operating_expense'
   WHERE company_id = v_demo AND account_subtype IS NULL AND is_system_account = false AND account_type = 'expense';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  RAISE NOTICE 'Demo done';

  -- Brightsphere
  UPDATE gl_accounts SET account_subtype = 'cost_of_sales'
   WHERE company_id = v_brightsphere AND account_subtype IS NULL AND is_system_account = false AND account_type = 'expense'
     AND account_code = '5100';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  UPDATE gl_accounts SET account_subtype = 'revenue'
   WHERE company_id = v_brightsphere AND account_subtype IS NULL AND is_system_account = false AND account_type = 'revenue';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  UPDATE gl_accounts SET account_subtype = 'operating_expense'
   WHERE company_id = v_brightsphere AND account_subtype IS NULL AND is_system_account = false AND account_type = 'expense';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;

  RAISE NOTICE 'Migration 608: % revenue/expense accounts subtyped', v_total;

  -- Post-conditions. Both hold on a re-run and after a hand reclassification.
  SELECT count(*) INTO v_bad FROM gl_accounts
   WHERE company_id = v_velocity AND is_system_account = false AND account_type = 'expense'
     AND (account_name ~* '^COS\M' OR account_name ~* '\mEX2\d{3}\M')
     AND account_subtype IS DISTINCT FROM 'cost_of_sales';
  IF v_bad > 0 THEN
    RAISE WARNING 'Migration 608: % Velocity cost-of-sales-named accounts carry another subtype (left as found)', v_bad;
  END IF;

  SELECT count(*) INTO v_bad FROM gl_accounts
   WHERE company_id IN (v_velocity, v_demo, v_brightsphere)
     AND is_system_account = false AND account_type IN ('revenue', 'expense')
     AND account_subtype IS NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Migration 608: % non-system revenue/expense accounts still NULL', v_bad;
  END IF;
END $$;
