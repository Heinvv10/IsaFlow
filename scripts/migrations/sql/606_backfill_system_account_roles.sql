-- 606_backfill_system_account_roles.sql
--
-- Create the system account roles migration 605 added to the seed template, for
-- the tenants that already exist. 605 fixes new tenants; 606 and 607 fix the
-- ones already here. This file CREATES accounts; 607 corrects accounts that are
-- already present and carry the wrong flag or subtype.
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
-- NOT DONE HERE, deliberately: no account is renumbered, renamed, reactivated
-- or reclassified. Brightsphere's `SYS3 Discount Received` is a poor account to
-- be holding `other_income` and it is left alone, because it does hold the role
-- and re-pointing it is chart correction, not this migration's job.
--
-- WHO ACTUALLY RECEIVES THESE ROWS. Production holds 13 companies, of which
-- FIVE are `status = 'deleted'` (My Test Company, QA-COMPANY-DELETE-ME and the
-- three Test Company E2E rows). `companies.is_active` is true on all 13, so
-- that column does not separate them — `status` does. They are backfilled
-- anyway and deliberately: the rows are inert in a tenant nobody opens, and a
-- tenant that is ever restored then works rather than throwing. But the counts
-- this migration is described by should be read as 8 live tenants and 5 dead
-- ones, not 13 equal ones.
--
-- WHAT A TENANT ALREADY USING 3300 OR 4410 GETS: nothing, and that is
-- deliberate. Both guards must pass — the code must be free AND no account may
-- carry the subtype — so a company using 3300 for, say, a directors loan is
-- skipped entirely rather than having a role forced onto an unrelated account or
-- silently renumbered. The same is true of a tenant whose only claimant is
-- deactivated or unflagged: skipped, not guessed at. That is why the closing DO
-- block reports every still-empty role by name — the skip is visible in the
-- deploy output instead of being discovered later from a 500. No production
-- company is in this state; only Weszak holds 3300 and it already holds the
-- role.
--
-- A FIX THAT OPENED A GAP ONE LAYER UP, AND THE LESSON. Creating these accounts
-- made the ledger resolvable and made the AFS wrong: `SUBTYPE_TO_AFS_CODE` in
-- `afsTaxonomySeeds.ts` had no entry for `opening_balance_equity` or
-- `disposal_profit_loss`, and `afsAutoMapper` falls through subtype, then name
-- patterns, then counts the account as skipped. Neither "Opening Balance
-- Equity" nor "Profit / Loss on Disposal of Assets" matches any pattern, so
-- every account these statements create would have been absent from the annual
-- financial statements — for opening-balance equity, equity missing from the
-- balance sheet. Both codes were added (`BS046` and `IS472`) in the same change
-- as this migration, with a test asserting the codes exist in the taxonomy.
--
-- The lesson is the general one: a role is not "supported" because the resolver
-- can find it. Every layer that enumerates subtypes — the AFS mapper, the
-- classifier, the VAT201 bucketing — is a place a new role can fall through
-- silently. Adding a subtype means walking those, not just the resolver.
--
-- ON THE LAZY PATH THAT ALSO CREATES 3300. `openingBalanceEquityService` creates
-- an Opening Balance Equity account on first use, trying 3300, 3310, 3320, 3390
-- in that order. It is NOT made redundant by this migration and the two cannot
-- collide: its `findExisting` selects on `account_subtype =
-- 'opening_balance_equity' AND is_system_account = true AND is_active = true`,
-- which is exactly the state the INSERT below creates, so after this runs it
-- finds the account and returns it and the creation branch never executes. No
-- duplicate, no contested role. Its first preferred code is 3300 — the same one
-- seeded here — so the two paths converge on the same account rather than
-- racing for different ones. The lazy path remains a genuine fallback for any
-- company that later loses the role, or is created in some window the seed does
-- not cover.

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
-- Counted over the two ROLE SUBTYPES, not over the bare account codes, and
-- restricted to rows this transaction wrote. The first version asked only
-- `account_code IN ('3300','4410') AND parent_account_id IS NULL` with no
-- company predicate and no time bound, so on isaflow_dev it announced "78 of the
-- new role accounts have no parent" on a run that inserted ZERO — all 78 were
-- pre-existing rows belonging to other tenants. A cross-tenant count inside a
-- tenant-scoped migration, printing a number that describes something other than
-- what it claims, is worse than printing nothing: it is the deploy log a human
-- reads when they are deciding whether the migration went well.
-- Counted per COMPANY and over the two role SUBTYPES, which only 605 and this
-- migration ever write — not over the bare account codes. A time bound was the
-- other option and it is not reliable here: `statement_timestamp()` inside a DO
-- block is evaluated after the INSERTs, and `transaction_timestamp()` is only
-- meaningful if the runner wraps the file in one transaction, which psql in
-- autocommit does not. This formulation needs neither.
DO $$
DECLARE orphans int;
BEGIN
  SELECT count(*) INTO orphans
    FROM companies c
   WHERE EXISTS (
           SELECT 1 FROM gl_accounts g
            WHERE g.company_id = c.id
              AND g.account_subtype IN ('opening_balance_equity', 'disposal_profit_loss')
              AND g.parent_account_id IS NULL
         );
  IF orphans > 0 THEN
    RAISE NOTICE 'mig 606: % compan(y/ies) hold a role account with no parent (missing 3000/4000)', orphans;
  END IF;
END $$;

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

