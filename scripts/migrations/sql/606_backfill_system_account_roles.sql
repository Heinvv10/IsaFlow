-- 606_backfill_system_account_roles.sql
--
-- Give every existing tenant the system account roles migration 605 added to
-- the seed template. 605 fixes new tenants; this fixes the ones already here.
--
-- Measured against production 2026-09-04 (13 companies). A role is held when an
-- account carries its `account_subtype` AND `is_system_account` AND `is_active`
-- — the exact filter `systemAccountResolver`'s cache applies:
--
--   disposal_profit_loss    missing on 13 of 13
--   opening_balance_equity  missing on 12 of 13   (Weszak has 3300 already)
--   other_income            missing on 12 of 13   (the account exists; the FLAG does not)
--   admin_expense           missing on 2          (Brightsphere, ISAFlow Demo)
--   bank                    missing on 1          (Brightsphere)
--
-- THREE SHAPES OF FIX, and they are deliberately different statements:
--
--   1. CREATE where nothing carries the subtype at all.
--   2. FLAG where an active account already carries it and is only missing
--      is_system_account. Creating a second account here would make the chart
--      worse — see the Brightsphere bank note below.
--   3. RETYPE, for two ISAFlow Demo accounts whose subtype was edited away from
--      the seeded value.
--
-- Every statement is scoped by company_id. Nothing matches on account name or
-- code alone: the tenant-specific fixes name their company by id, and the
-- universal ones correlate every predicate to the company row being inserted
-- for. Idempotent throughout — a re-run finds its own work and does nothing.
--
-- NOT DONE HERE, deliberately: no account is renumbered, renamed, reactivated
-- or reclassified beyond the roles above. Brightsphere's `SYS3 Discount
-- Received` is a poor account to be holding `other_income` and it is left
-- alone, because it does hold the role and re-pointing it is chart correction,
-- not this migration's job.

-- ── 1. Opening Balance Equity ───────────────────────────────────────────────
--
-- The contra an opening trial balance posts against; nets to zero once the
-- opening TB is complete. Absent from the 476 seed entirely.
--
-- Guarded twice per company: skip if the company already uses code 3300 (the
-- unique index is (company_id, account_code)), and skip if ANY account of that
-- company already carries the subtype in any state. The second guard is the
-- conservative one — a company whose account merely lacks the system flag needs
-- that flag set, not a second account, and this migration will not guess which
-- account that is. `chart_of_accounts_health` reports those as
-- unflagged_active_claimant for a human.
INSERT INTO gl_accounts (
  company_id, account_code, account_name, account_type, account_subtype,
  normal_balance, level, display_order, is_system_account, is_active, parent_account_id
)
SELECT c.id, '3300', 'Opening Balance Equity', 'equity', 'opening_balance_equity',
       'credit', 3, 330, true, true,
       (SELECT p.id FROM gl_accounts p
         WHERE p.company_id = c.id AND p.account_code = '3000')
FROM companies c
WHERE NOT EXISTS (
        SELECT 1 FROM gl_accounts g
         WHERE g.company_id = c.id AND g.account_code = '3300'
      )
  AND NOT EXISTS (
        SELECT 1 FROM gl_accounts g
         WHERE g.company_id = c.id AND g.account_subtype = 'opening_balance_equity'
      );

-- ── 2. Profit / Loss on Disposal of Assets ──────────────────────────────────
--
-- `glCrossModuleHooks.postAssetDisposalToGL` resolves this and no longer
-- log-and-returns-null, so without it every asset disposal on every tenant
-- throws. Nothing in production carries the subtype today, on any company, in
-- any state.
--
-- Revenue side: the usual SA presentation puts profit/(loss) on disposal under
-- other income, with a loss as a debit against it. `glAccountSubtypes.ts`
-- permits the subtype on revenue and expense both, and the hook debits for a
-- loss and credits for a gain, so either side balances — this is a presentation
-- choice, not an arithmetic one.
--
-- 4410 rather than 4400: Weszak Beleggings already holds 4400 as "Rental
-- Income". One uniform code across every tenant beats a code that varies by
-- tenant, because a role whose code differs per company is a role someone
-- eventually resolves by code instead of by subtype — which is the coupling the
-- resolver exists to remove.
INSERT INTO gl_accounts (
  company_id, account_code, account_name, account_type, account_subtype,
  normal_balance, level, display_order, is_system_account, is_active, parent_account_id
)
SELECT c.id, '4410', 'Profit / Loss on Disposal of Assets', 'revenue', 'disposal_profit_loss',
       'credit', 3, 440, true, true,
       (SELECT p.id FROM gl_accounts p
         WHERE p.company_id = c.id AND p.account_code = '4000')
FROM companies c
WHERE NOT EXISTS (
        SELECT 1 FROM gl_accounts g
         WHERE g.company_id = c.id AND g.account_code = '4410'
      )
  AND NOT EXISTS (
        SELECT 1 FROM gl_accounts g
         WHERE g.company_id = c.id AND g.account_subtype = 'disposal_profit_loss'
      );

-- Every production company has 3000 and 4000, so the parent resolves. A company
-- without one still gets its account (parent_account_id is nullable) rather than
-- silently keeping an empty role — a parentless account resolves correctly and
-- chart_of_accounts_health reports the orphan. Say so if it happens.
DO $$
DECLARE orphans int;
BEGIN
  SELECT count(*) INTO orphans FROM gl_accounts
   WHERE account_code IN ('3300', '4410') AND parent_account_id IS NULL;
  IF orphans > 0 THEN
    RAISE NOTICE 'mig 606: % of the new role accounts have no parent (company missing 3000/4000)', orphans;
  END IF;
END $$;

-- ── 3. Other Income: the flag, not the account ──────────────────────────────
--
-- `4300 Other Income` is seeded with account_subtype = 'other_income' and
-- is_system_account = false. Migration 254 has the same omission — its 4300
-- line is the one line in that file that sets a subtype without the flag. So
-- every tenant has the account and none of them can resolve the role, and
-- `items/adjustmentService` throws on a positive stock adjustment.
--
-- Enumerated by (company_id, account_code) because the choice of account is a
-- judgement, not a rule: Dotbiz (779d1c87) has no 4300 and its Other Income is
-- 4200, and Dotbiz (Pty) Ltd (9f4cccf9) has both 4200 and 4300 and 4300 is the
-- one to flag. A value-only match on the name "Other Income" would have picked
-- differently, and wrongly, on both.
--
-- Brightsphere is absent on purpose: SYS3 already holds the role there.
UPDATE gl_accounts g
   SET is_system_account = true,
       updated_at        = NOW()
  FROM (VALUES
    ('779d1c87-b9ad-4c4b-8b6c-497421fd2654'::uuid, '4200'),  -- Dotbiz (no 4300)
    ('9f4cccf9-5892-4155-b5a8-6ca460641542'::uuid, '4300'),  -- Dotbiz (Pty) Ltd
    ('1d038805-3663-4e72-9daa-6ae9f11eefa3'::uuid, '4300'),  -- EG Plumbing
    ('d6184044-047a-4ae7-bc97-c9a3a136e66a'::uuid, '4300'),  -- H10 Holdings
    ('915b7146-cb2a-4e81-8705-3022fda40a0c'::uuid, '4300'),  -- My Test Company
    ('fa3530e2-1abf-4fb1-a3ad-313ed6d977c2'::uuid, '4300'),  -- QA-COMPANY-DELETE-ME
    ('cd6445b7-3d0b-42c3-931e-10c7908cceb8'::uuid, '4300'),  -- Test Company E2E
    ('c40414ea-1e1d-444c-887b-d371f2195dbd'::uuid, '4300'),  -- Test Company E2E
    ('9920c69d-f581-42d4-af58-198d741924ad'::uuid, '4300'),  -- Test Company E2E
    ('4a159669-2f50-46b5-a7b8-2e94dab3d495'::uuid, '4300'),  -- Velocity Fibre
    ('661a92be-2cd5-43fe-a841-d3b50cf740d1'::uuid, '4300')   -- Weszak Beleggings
  ) AS t(company_id, account_code)
 WHERE g.company_id      = t.company_id
   AND g.account_code    = t.account_code
   AND g.account_subtype = 'other_income'   -- refuse to flag an account that
   AND g.is_active       = true             -- drifted since this was measured
   AND g.is_system_account IS DISTINCT FROM true
   -- ...and refuse if the role is already held. Every one of these statements
   -- exists to fill an EMPTY role; flagging a second claimant would create the
   -- contested-role state that migration 525 was written to clean up, where the
   -- resolver picks deterministically between rivals and every auto-posting
   -- depends on the pick. Found on isaflow_dev, whose charts differ from
   -- production's: without this guard the bank statement below flagged a second
   -- active bank account there.
   AND NOT EXISTS (
         SELECT 1 FROM gl_accounts h
          WHERE h.company_id        = g.company_id
            AND h.account_subtype   = 'other_income'
            AND h.is_system_account = true
            AND h.is_active         = true
       );

-- ── 4. ISAFlow Demo: two subtypes edited away from the seeded value ─────────
--
-- 5600 "Administrative Expenses" carries `operating_expense` and 4300 "Other
-- Income" carries `revenue`. Both are the obviously-intended claimants by name
-- and both have postings (390 and 159 lines), so this is a retype of a live
-- account and it was signed off as such.
--
-- REPORTED FIGURES DO NOT MOVE, verified against `accountClassification.ts`:
-- the income-statement bucketing keys off account_TYPE, which is unchanged.
-- The expense branch splits `cost_of_sales`, then the OTHER_EXPENSE set, then
-- everything else to operatingExpenses — `admin_expense` and
-- `operating_expense` both land in that last band. Revenue is the same shape.
-- Nobody needs to re-derive this.
UPDATE gl_accounts
   SET account_subtype   = 'admin_expense',
       is_system_account = true,
       updated_at        = NOW()
 WHERE company_id      = '00000000-0000-0000-0000-000000000001'::uuid
   AND account_code    = '5600'
   AND account_subtype = 'operating_expense'
   AND NOT EXISTS (
         SELECT 1 FROM gl_accounts h
          WHERE h.company_id        = '00000000-0000-0000-0000-000000000001'::uuid
            AND h.account_subtype   = 'admin_expense'
            AND h.is_system_account = true
            AND h.is_active         = true
       );

UPDATE gl_accounts
   SET account_subtype   = 'other_income',
       is_system_account = true,
       updated_at        = NOW()
 WHERE company_id      = '00000000-0000-0000-0000-000000000001'::uuid
   AND account_code    = '4300'
   AND account_subtype = 'revenue'
   AND NOT EXISTS (
         SELECT 1 FROM gl_accounts h
          WHERE h.company_id        = '00000000-0000-0000-0000-000000000001'::uuid
            AND h.account_subtype   = 'other_income'
            AND h.is_system_account = true
            AND h.is_active         = true
       );

-- ── 5. Brightsphere bank: flag the account that holds the history ───────────
--
-- Four accounts carry subtype 'bank' here:
--
--   1049686  Brighttech Absa       active,      not system,  8,342 bank txns
--   1049687  Brighttech - Absa 2   active,      not system,    511 bank txns
--   1110     Bank - Primary        deactivated, system,          0 bank txns
--   1001     Current Account       deactivated, system,          0 bank txns
--
-- The role is empty because the two system rows are deactivated and the two
-- active rows are unflagged. Creating a fresh "Bank - Primary" would have
-- pointed every future auto-posting at an account with no history, next to one
-- with 8,342 transactions. 1049686 is the operating bank by three orders of
-- magnitude; it is already active, so only the flag moves. 1049687 is left
-- alone — the role is "primary bank", not "every bank".
UPDATE gl_accounts
   SET is_system_account = true,
       updated_at        = NOW()
 WHERE company_id      = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c'::uuid
   AND account_code    = '1049686'
   AND account_subtype = 'bank'
   AND is_active       = true
   AND is_system_account IS DISTINCT FROM true
   -- Only when the role is empty. In production Brightsphere's other two bank
   -- system rows are deactivated so it always is; on isaflow_dev 1110 is active
   -- and this statement, unguarded, made `bank` contested between 1110 and
   -- 1049686 — two active system accounts for one role, which is precisely the
   -- state migration 525 existed to remove.
   AND NOT EXISTS (
         SELECT 1 FROM gl_accounts h
          WHERE h.company_id        = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c'::uuid
            AND h.account_subtype   = 'bank'
            AND h.is_system_account = true
            AND h.is_active         = true
       );

-- ── 6. Brightsphere admin_expense: a new account, on a free code ────────────
--
-- Both existing claimants (5500 and 6005, both named "Administrative Expenses",
-- both is_system_account, both with zero journal lines) are DEACTIVATED. The
-- fix is additive rather than a reactivation: reactivating an account is a chart
-- correction and this migration does not make those.
--
-- The code is 6010 and NOT 5600, which is what was originally proposed and
-- signed off. Brightsphere's chart is the seeded layout shifted by 100 — their
-- 5500 is Administrative Expenses, 5600 is Bank Charges, 5700 is Depreciation
-- Expense — so 5600 is occupied and (company_id, account_code) is unique. 6010
-- is free in Brightsphere's chart, and sits beside 6005, the other
-- Administrative Expenses row, rather than landing in the middle of the Sage
-- band. Their real admin spend lives in the Sage accounts 45009348 Office
-- Expenses / 34024634 General Expenses / 42386703 Management and aAdmin fees,
-- none of which is touched: this account exists to give `admin_expense` a
-- resolvable home for AR write-offs and VAT adjustments, which is what the role
-- is for.
INSERT INTO gl_accounts (
  company_id, account_code, account_name, account_type, account_subtype,
  normal_balance, level, display_order, is_system_account, is_active, parent_account_id
)
SELECT 'd27bac33-cdc0-4e58-bf6b-709c1597d41c'::uuid, '6010', 'Administrative Expenses',
       'expense', 'admin_expense', 'debit', 3, 601, true, true,
       (SELECT p.id FROM gl_accounts p
         WHERE p.company_id = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c'::uuid
           AND p.account_code = '5000')
WHERE NOT EXISTS (
        SELECT 1 FROM gl_accounts g
         WHERE g.company_id = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c'::uuid
           AND g.account_code = '6010'
      )
  AND NOT EXISTS (
        SELECT 1 FROM gl_accounts g
         WHERE g.company_id = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c'::uuid
           AND g.account_subtype = 'admin_expense'
           AND g.is_active = true
           AND g.is_system_account = true
      );

-- ── Report what is still empty ──────────────────────────────────────────────
--
-- Not a guard — the migration has done everything it is allowed to do by the
-- time this runs. It exists so a run against an environment whose charts differ
-- from production (isaflow_dev, a restored snapshot) says so in the output
-- rather than leaving someone to discover it from a 500.
DO $$
DECLARE
  role_name text;
  gaps      int := 0;
BEGIN
  FOR role_name IN
    SELECT unnest(ARRAY[
      'bank', 'receivable', 'payable', 'vat_input', 'vat_output',
      'retained_earnings', 'opening_balance_equity', 'default_revenue',
      'other_income', 'default_expense', 'admin_expense',
      'accumulated_depreciation', 'depreciation_expense', 'disposal_profit_loss'
    ])
  LOOP
    SELECT count(*) INTO gaps
      FROM companies c
     WHERE NOT EXISTS (
             SELECT 1 FROM gl_accounts g
              WHERE g.company_id = c.id
                AND g.account_subtype = role_name
                AND g.is_system_account = true
                AND g.is_active = true
           );
    IF gaps > 0 THEN
      RAISE NOTICE 'mig 606: role % is still empty on % compan(y/ies)', role_name, gaps;
    END IF;
  END LOOP;
END $$;
