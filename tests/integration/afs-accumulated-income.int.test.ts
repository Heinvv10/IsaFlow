// tests/integration/afs-accumulated-income.int.test.ts
//
// IS485 is labelled "Accumulated income (loss) end of year". As a running
// total it is the previous total plus the lines between it, which gave profit
// after tax less dividends — THIS YEAR'S retained profit, with no prior year
// in it anywhere. For a company in its third year with 900,000 of accumulated
// income, 100,000 of current profit and 40,000 of dividends, the line rendered
// 60,000 against a true 960,000, and the gap grew every year it traded.
//
// It is the line a reader is most likely to tie back to retained earnings on
// the balance sheet, where it would then disagree by the entire accumulated
// history.
//
// The taxonomy has no opening-accumulated line and no GL account maps to one,
// so it is derived and inserted into the running chain. These tests assert the
// accumulated figure, and that it reconciles to the equity statement's opening
// retained earnings — the two must agree or the pack contradicts itself.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import {
  fetchSectionLines,
  rollUpTotals,
  ACCUMULATED_BF_CODE,
} from '@/modules/accounting/services/afs/noteGenerators/primaryStatements/_helpers';
import { getChangesInEquity } from '@/modules/accounting/services/afs/changesInEquityService';
import { seedDefaultTaxonomy } from '@/modules/accounting/services/afs/afsMappingService';

const DATABASE_URL = process.env.DATABASE_URL;

const COMPANY = '00000000-0000-0000-0000-00000000ac01';
const GL_BANK = '00000000-0000-0000-0000-00000000ac02';
const GL_REVENUE = '00000000-0000-0000-0000-00000000ac03';
const GL_EXPENSE = '00000000-0000-0000-0000-00000000ac04';

const FISCAL_YEAR = 2026;

// Two prior years of trading, never closed into retained earnings — which is
// the normal state, since the year-end close cannot run.
const PRIOR_ACCUMULATED = 900000;
// Current year.
const CURRENT_REVENUE = 400000;
const CURRENT_EXPENSES = 300000;
const CURRENT_PROFIT = CURRENT_REVENUE - CURRENT_EXPENSES; // 100000

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('accumulated income at year end includes every prior year', () => {
  let admin: Pool;

  beforeAll(async () => {
    assertNotProductionDb('This test inserts and deletes journal fixtures.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await cleanup(admin);

    await admin.query(
      `INSERT INTO companies (id, name, is_active, financial_year_start)
       VALUES ($1, 'Accumulated Fixture', true, 1) ON CONFLICT (id) DO NOTHING`,
      [COMPANY],
    );
    await admin.query(
      `INSERT INTO gl_accounts
         (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
       VALUES
         ($2,$1,'AC1000','Bank',    'asset',  'bank',              'debit', true),
         ($3,$1,'AC4000','Revenue', 'revenue','sales',             'credit',true),
         ($4,$1,'AC5000','Expenses','expense','operating_expense', 'debit', true)
       ON CONFLICT (id) DO NOTHING`,
      [COMPANY, GL_BANK, GL_REVENUE, GL_EXPENSE],
    );

    // The real taxonomy, so IS480 and IS485 exist with the bases the seeder
    // writes.
    await seedDefaultTaxonomy(COMPANY);

    // Map the two P&L accounts onto taxonomy lines. Without mappings every
    // leaf reads 0 and the statement shows nothing — which is the separate
    // unmapped-account defect the pre-export tie-out now blocks on.
    await admin.query(
      `INSERT INTO afs_account_mappings (company_id, gl_account_id, afs_line_code)
       VALUES ($1,$2,'IS002'), ($1,$3,'IS166')
       ON CONFLICT DO NOTHING`,
      [COMPANY, GL_REVENUE, GL_EXPENSE],
    );

    // Prior years: 900,000 of accumulated profit, left in revenue.
    await postEntry(admin, 'ac-py', '2024-06-01', [
      { account: GL_BANK, debit: PRIOR_ACCUMULATED, credit: 0 },
      { account: GL_REVENUE, debit: 0, credit: PRIOR_ACCUMULATED },
    ]);

    // Current year.
    await postEntry(admin, 'ac-cy-rev', '2026-05-01', [
      { account: GL_BANK, debit: CURRENT_REVENUE, credit: 0 },
      { account: GL_REVENUE, debit: 0, credit: CURRENT_REVENUE },
    ]);
    await postEntry(admin, 'ac-cy-exp', '2026-06-01', [
      { account: GL_EXPENSE, debit: CURRENT_EXPENSES, credit: 0 },
      { account: GL_BANK, debit: 0, credit: CURRENT_EXPENSES },
    ]);
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await cleanup(admin);
    await admin.end();
  });

  it('carries the prior years into the income statement as an opening balance', async () => {
    const lines = await fetchSectionLines(COMPANY, 'income_statement', FISCAL_YEAR, FISCAL_YEAR - 1);
    const opening = lines.find((l) => l.code === ACCUMULATED_BF_CODE);

    expect(opening).toBeDefined();
    // Raw debit-minus-credit: a credit-positive accumulated income is negative.
    expect(opening!.currentAmount).toBeCloseTo(-PRIOR_ACCUMULATED, 2);
  });

  it('places the opening line where the running chain will pick it up', async () => {
    const lines = await fetchSectionLines(COMPANY, 'income_statement', FISCAL_YEAR, FISCAL_YEAR - 1);

    const opening = lines.find((l) => l.code === ACCUMULATED_BF_CODE)!;
    const afterTax = lines.find((l) => l.code === 'IS480');
    const endOfYear = lines.find((l) => l.code === 'IS485');

    // Between "Net income after taxation" and "Accumulated income end of year",
    // and in the array in that order — the renderer prints this order.
    expect(opening.sortOrder).toBeGreaterThan(afterTax!.sortOrder);
    expect(opening.sortOrder).toBeLessThan(endOfYear!.sortOrder);
    expect(lines.indexOf(opening)).toBeGreaterThan(lines.indexOf(afterTax!));
    expect(lines.indexOf(opening)).toBeLessThan(lines.indexOf(endOfYear!));
  });

  it('reports accumulated income end of year, not just this year', async () => {
    const lines = rollUpTotals(
      await fetchSectionLines(COMPANY, 'income_statement', FISCAL_YEAR, FISCAL_YEAR - 1),
    );
    const endOfYear = lines.find((l) => l.code === 'IS485')!;

    // 900,000 brought forward + 100,000 earned. Reported 100,000 before.
    expect(-endOfYear.currentAmount).toBeCloseTo(PRIOR_ACCUMULATED + CURRENT_PROFIT, 2);
  });

  it('agrees with the equity statement on closing retained earnings', async () => {
    const lines = rollUpTotals(
      await fetchSectionLines(COMPANY, 'income_statement', FISCAL_YEAR, FISCAL_YEAR - 1),
    );
    const endOfYear = -lines.find((l) => l.code === 'IS485')!.currentAmount;

    const equity = await getChangesInEquity(COMPANY, '2026-01-01', '2026-12-31');
    const retained = equity.columns.find((c) => c.subtype === 'retained_earnings')!;

    // Two statements in the same pack, computed from different code paths.
    // If they disagree the pack contradicts itself on its most-read figure.
    expect(endOfYear).toBeCloseTo(retained.closing, 2);
  });
});

interface Leg { account: string; debit: number; credit: number }

async function postEntry(admin: Pool, entryNumber: string, entryDate: string, legs: Leg[]): Promise<void> {
  const { rows } = await admin.query(
    `INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, created_by)
     VALUES ($1,$2,$3,'accumulated fixture','posted',$1) RETURNING id`,
    [COMPANY, entryNumber, entryDate],
  );
  for (const leg of legs) {
    await admin.query(
      `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
       VALUES ($1,$2,$3,$4,$5)`,
      [COMPANY, rows[0].id, leg.account, leg.debit, leg.credit],
    );
  }
}

async function cleanup(admin: Pool): Promise<void> {
  await admin.query('DELETE FROM gl_journal_lines WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM afs_account_mappings WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM afs_statement_lines WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM gl_accounts WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM companies WHERE id = $1', [COMPANY]);
}
