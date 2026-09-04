-- 607_fix_near_miss_system_account_roles.sql
--
-- Correct the system account roles that are empty because an account that
-- ALREADY EXISTS carries the wrong flag or the wrong subtype. 606 creates the
-- roles nothing claims; this file fixes the ones where creating a second
-- account would make the chart worse.
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
-- Every statement is scoped by company_id. Nothing matches on account name or
-- code alone: the tenant-specific fixes name their company by id, and the
-- universal ones correlate every predicate to the company row being inserted
-- for. Idempotent throughout — a re-run finds its own work and does nothing.
--
-- SPLIT ACROSS 606 AND 607 because the two halves are different operations with
-- different risk. 606 only ever INSERTs, so its worst case is an unused account;
-- 607 modifies rows that already exist and carry postings. Reviewing and
-- reasoning about rollback for those separately is worth more than keeping one
-- 318-line file, which was over the 300-line cap besides. Both must run for the
-- backfill to be complete; running only 606 leaves a strictly better state than
-- running neither, never a worse one.
--
-- THE DISTINCTION IS THE WHOLE POINT OF SPLITTING THESE. Brightsphere's `bank`
-- role is empty next to an account holding 8,342 bank transactions. Answering
-- that with a new "Bank - Primary" would have aimed every future auto-posting at
-- an account with no history. `chart_of_accounts_health` now reports this shape
-- as `unflagged_active_claimant` precisely so nobody makes that mistake by hand.
--
-- Every statement here additionally refuses to act if the role is ALREADY held.
-- These exist to fill an EMPTY role; flagging a second claimant would create the
-- contested state migration 525 was written to clean up, where the resolver
-- picks deterministically between rivals and every auto-posting depends on the
-- pick. That guard is not theoretical: on isaflow_dev, whose `1110 Bank -
-- Primary` is active where production's is not, the unguarded bank statement
-- flagged a second active bank account and made the role contested.

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
-- WHAT MOVES AND WHAT DOES NOT — stated narrowly, because the first version of
-- this comment claimed "reported figures do not move" and that was broader than
-- the evidence behind it.
--
-- VERIFIED UNCHANGED. The income statement and balance sheet, per
-- `accountClassification.ts`: bucketing keys off account_TYPE, which these
-- statements do not touch. The expense branch splits `cost_of_sales`, then the
-- OTHER_EXPENSE set, then everything else to operatingExpenses, so
-- `admin_expense` and `operating_expense` land in the same band; revenue is the
-- same shape. Cash flow too, per `cashFlowClassification.ts:75-76`, which puts
-- both subtypes in `cash_paid_to_suppliers`.
--
-- WHAT DOES MOVE: the AFS. ISAFlow Demo has ZERO rows in
-- `afs_account_mappings`, and `autoMapAccounts` maps only accounts that are not
-- yet mapped — so the next AFS run maps these two by their NEW subtype:
--   5600 (390 journal lines)  operating_expense -> IS253  becomes  admin_expense -> IS160
--   4300 (159 journal lines)  revenue           -> IS002  becomes  other_income  -> IS143
--
-- 4300 -> IS143 "Other income" is an improvement. 5600 -> IS160 is NOT: IS160 is
-- "Accounting officer's remuneration", a specific statutory disclosure line, and
-- 390 lines of general administrative spend do not belong in it. That is a
-- defect in the PRE-EXISTING `admin_expense -> IS160` entry of
-- `SUBTYPE_TO_AFS_CODE`, not something these statements introduce — every
-- company already carrying `admin_expense` has it. It is left alone here
-- deliberately: correcting it moves other tenants' AFS figures and belongs in
-- its own change. Fixing that entry restores 5600 to a general-expenses line.
-- ISAFlow Demo is the demo tenant, so nothing filed depends on it in the
-- meantime.
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
-- FIVE accounts carry subtype 'bank' here:
--
--   1049686  Brighttech Absa           active,      not system,  8,342 bank txns
--   1049687  Brighttech - Absa 2       active,      not system,    511 bank txns
--   1110     Bank - Primary            deactivated, system,          0 bank txns
--   1001     Current Account           deactivated, system,          0 bank txns
--   1116     QA Test Bank 2026-04-12   deactivated, not system,      0 bank txns
--
-- The fifth is a QA leftover: deactivated AND unflagged, so it is invisible to
-- the resolver, untouched by the statement below, and irrelevant to the choice.
-- It is listed anyway because an inexact census in a migration comment is the
-- kind of thing someone checks against the database two years from now and then
-- distrusts the rest of the file.
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
