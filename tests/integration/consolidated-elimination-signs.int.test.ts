// tests/integration/consolidated-elimination-signs.int.test.ts
//
// An intercompany elimination removes BOTH sides of an internal trade: the
// selling company's revenue and the buying company's expense. Eliminating
// R100 of intercompany sales must therefore leave group profit UNCHANGED —
// revenue falls 100, expenses fall 100.
//
// getConsolidatedIncomeStatement applied the elimination with the wrong sign
// on expenses. Member amounts are accumulated in each account's natural
// direction:
//
//     amount = type === 'revenue' ? credit - debit : debit - credit
//
// but the elimination was always `credit - debit`, whatever the account:
//
//     entry.eliminationAmount += elim.credit - elim.debit
//
// A standard elimination journal debits revenue 100 and credits expense 100.
// On the revenue line that is -100, which is right. On the expense line it is
// +100 — the same sign as the expense itself — so group expenses went UP by
// 100 instead of down. Group profit moved by 200 for a 100 elimination, in the
// wrong direction.
//
// getConsolidatedBalanceSheet already did this correctly, keying the sign off
// the account's normal balance; only the income statement did not.
//
// Consolidation is dormant in production (no group_accounts, no posted
// consolidation_adjustments), so this is latent rather than live — but it is
// wrong the first time anyone eliminates anything.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { getConsolidatedIncomeStatement } from '@/modules/accounting/services/reports/consolidatedStatementsService';

const DATABASE_URL = process.env.DATABASE_URL;

const GROUP = '00000000-0000-0000-0000-00000000e100';
const SELLER = '00000000-0000-0000-0000-00000000e101';
const BUYER = '00000000-0000-0000-0000-00000000e102';

const SELLER_REVENUE_ACC = '00000000-0000-0000-0000-00000000e111';
const BUYER_EXPENSE_ACC = '00000000-0000-0000-0000-00000000e112';
const SELLER_BANK = '00000000-0000-0000-0000-00000000e113';
const BUYER_BANK = '00000000-0000-0000-0000-00000000e114';

const GROUP_REVENUE_ACC = '00000000-0000-0000-0000-00000000e121';
const GROUP_EXPENSE_ACC = '00000000-0000-0000-0000-00000000e122';

const PERIOD_START = '2026-01-01';
const PERIOD_END = '2026-12-31';

// The seller invoices the buyer 100, internally. Both sides are recognised in
// their own books, and both must disappear on consolidation.
const INTERCOMPANY = 100;
// Plus genuine third-party trade, so the group is not all internal.
const EXTERNAL_REVENUE = 1000;
const EXTERNAL_EXPENSE = 400;

const EXPECTED_GROUP_REVENUE = EXTERNAL_REVENUE;                 // 1000
const EXPECTED_GROUP_EXPENSES = EXTERNAL_EXPENSE;                // 400
const EXPECTED_GROUP_PROFIT = EXTERNAL_REVENUE - EXTERNAL_EXPENSE; // 600

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('an intercompany elimination removes both sides of the trade', () => {
  let admin: Pool;

  beforeAll(async () => {
    assertNotProductionDb('This test inserts and deletes consolidation fixtures.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await cleanup(admin);

    await admin.query(
      `INSERT INTO companies (id, name, is_active) VALUES
         ($1,'Elim Seller',true), ($2,'Elim Buyer',true)
       ON CONFLICT (id) DO NOTHING`,
      [SELLER, BUYER],
    );
    await admin.query(
      `INSERT INTO company_groups (id, name, holding_company_id)
       VALUES ($1,'Elimination Fixture Group',$2) ON CONFLICT (id) DO NOTHING`,
      [GROUP, SELLER],
    );
    await admin.query(
      `INSERT INTO company_group_members (group_id, company_id, ownership_pct)
       VALUES ($1,$2,100), ($1,$3,100) ON CONFLICT DO NOTHING`,
      [GROUP, SELLER, BUYER],
    );

    await admin.query(
      `INSERT INTO gl_accounts
         (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
       VALUES
         ($1,$5,'EL4000','Sales',   'revenue','sales',            'credit',true),
         ($2,$6,'EL5000','Purchases','expense','operating_expense','debit', true),
         ($3,$5,'EL1000','Bank',    'asset',  'bank',             'debit', true),
         ($4,$6,'EL1000','Bank',    'asset',  'bank',             'debit', true)
       ON CONFLICT (id) DO NOTHING`,
      [SELLER_REVENUE_ACC, BUYER_EXPENSE_ACC, SELLER_BANK, BUYER_BANK, SELLER, BUYER],
    );

    await admin.query(
      `INSERT INTO group_accounts (id, group_id, account_code, account_name, account_type, normal_balance)
       VALUES ($1,$3,'G4000','Group Revenue','revenue','credit'),
              ($2,$3,'G5000','Group Expenses','expense','debit')
       ON CONFLICT (id) DO NOTHING`,
      [GROUP_REVENUE_ACC, GROUP_EXPENSE_ACC, GROUP],
    );
    await admin.query(
      `INSERT INTO group_coa_mappings (group_id, company_id, company_account_id, group_account_id)
       VALUES ($1,$2,$3,$4), ($1,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [GROUP, SELLER, SELLER_REVENUE_ACC, GROUP_REVENUE_ACC, BUYER, BUYER_EXPENSE_ACC, GROUP_EXPENSE_ACC],
    );

    // Seller: 1000 external sales + 100 to the buyer.
    await postEntry(admin, SELLER, 'el-s1', '2026-03-01', [
      { account: SELLER_BANK, debit: EXTERNAL_REVENUE, credit: 0 },
      { account: SELLER_REVENUE_ACC, debit: 0, credit: EXTERNAL_REVENUE },
    ]);
    await postEntry(admin, SELLER, 'el-s2', '2026-03-02', [
      { account: SELLER_BANK, debit: INTERCOMPANY, credit: 0 },
      { account: SELLER_REVENUE_ACC, debit: 0, credit: INTERCOMPANY },
    ]);

    // Buyer: 400 external costs + the 100 bought from the seller.
    await postEntry(admin, BUYER, 'el-b1', '2026-04-01', [
      { account: BUYER_EXPENSE_ACC, debit: EXTERNAL_EXPENSE, credit: 0 },
      { account: BUYER_BANK, debit: 0, credit: EXTERNAL_EXPENSE },
    ]);
    await postEntry(admin, BUYER, 'el-b2', '2026-04-02', [
      { account: BUYER_EXPENSE_ACC, debit: INTERCOMPANY, credit: 0 },
      { account: BUYER_BANK, debit: 0, credit: INTERCOMPANY },
    ]);

    // The elimination: debit group revenue, credit group expenses.
    await admin.query(
      `INSERT INTO consolidation_adjustments
         (group_id, period_start, period_end, status, adjustment_type, description, lines)
       VALUES ($1,$2,$3,'posted','elimination','Eliminate intercompany sales',$4::jsonb)`,
      [
        GROUP, PERIOD_START, PERIOD_END,
        JSON.stringify([
          { groupAccountId: GROUP_REVENUE_ACC, debit: INTERCOMPANY, credit: 0 },
          { groupAccountId: GROUP_EXPENSE_ACC, debit: 0, credit: INTERCOMPANY },
        ]),
      ],
    );
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await cleanup(admin);
    await admin.end();
  });

  it('removes the intercompany revenue', async () => {
    const report = await getConsolidatedIncomeStatement(GROUP, PERIOD_START, PERIOD_END);
    expect(report.totalRevenue.consolidatedAmount).toBeCloseTo(EXPECTED_GROUP_REVENUE, 2);
  });

  it('removes the intercompany expense rather than adding it again', async () => {
    const report = await getConsolidatedIncomeStatement(GROUP, PERIOD_START, PERIOD_END);
    // The sign inversion reported 600 here — the buyer's 500 plus the 100
    // elimination added instead of subtracted — rather than 400.
    expect(report.totalOperatingExpenses.consolidatedAmount)
      .toBeCloseTo(EXPECTED_GROUP_EXPENSES, 2);
  });

  it('leaves group profit unchanged by an elimination of an internal trade', async () => {
    const report = await getConsolidatedIncomeStatement(GROUP, PERIOD_START, PERIOD_END);

    // This is the property: an internal sale creates no group profit, so
    // removing it must not move group profit either.
    expect(report.netProfit.consolidatedAmount).toBeCloseTo(EXPECTED_GROUP_PROFIT, 2);
  });

  it('group profit equals revenue less cost of sales less operating expenses', async () => {
    const report = await getConsolidatedIncomeStatement(GROUP, PERIOD_START, PERIOD_END);

    expect(report.netProfit.consolidatedAmount).toBeCloseTo(
      report.totalRevenue.consolidatedAmount
        - report.totalCostOfSales.consolidatedAmount
        - report.totalOperatingExpenses.consolidatedAmount,
      2,
    );
  });
});

interface Leg { account: string; debit: number; credit: number }

async function postEntry(
  admin: Pool, companyId: string, entryNumber: string, entryDate: string, legs: Leg[],
): Promise<void> {
  const { rows } = await admin.query(
    `INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, created_by)
     VALUES ($1,$2,$3,'elimination fixture','posted',$1) RETURNING id`,
    [companyId, entryNumber, entryDate],
  );
  for (const leg of legs) {
    await admin.query(
      `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
       VALUES ($1,$2,$3,$4,$5)`,
      [companyId, rows[0].id, leg.account, leg.debit, leg.credit],
    );
  }
}

async function cleanup(admin: Pool): Promise<void> {
  await admin.query('DELETE FROM consolidation_adjustments WHERE group_id = $1', [GROUP]);
  await admin.query('DELETE FROM group_coa_mappings WHERE group_id = $1', [GROUP]);
  await admin.query('DELETE FROM group_accounts WHERE group_id = $1', [GROUP]);
  await admin.query('DELETE FROM company_group_members WHERE group_id = $1', [GROUP]);
  await admin.query('DELETE FROM company_groups WHERE id = $1', [GROUP]);
  for (const c of [SELLER, BUYER]) {
    await admin.query('DELETE FROM gl_journal_lines WHERE company_id = $1', [c]);
    await admin.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [c]);
    await admin.query('DELETE FROM gl_accounts WHERE company_id = $1', [c]);
    await admin.query('DELETE FROM companies WHERE id = $1', [c]);
  }
}
