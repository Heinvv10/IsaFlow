/**
 * PR #768 round 8 (review M1): the AFS pack reads dividends in a take-on
 * journal (gl/takeOnJournalSource) the same way everywhere. A take-on carries
 * them in as a balance, so the income statement's IS484 "Dividends paid" (and
 * the IS485 running total built on it) leaves them out, the AFS SOCE shows
 * them in a "Balances taken on" column rather than inside Movement, and the
 * report SOCE agrees; a dividend paid after the take-on is a dividend in all
 * three. The SOCE still closes on the SFP's equity.
 *
 * The G-01 fixture tenant, with a debit-normal "Dividends paid" equity account
 * mapped to IS484: 200 carried in by a take-on journal on 2025-06-30 and 300
 * paid on 2025-11-30, both from the bank.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { newTenant, seedTenant, cleanupTenant } from './helpers/g01Fixture';
import { generateStatementOfFinancialPosition } from '../../src/modules/accounting/services/afs/noteGenerators/primaryStatements/balanceSheet';
import { generateChangesInEquity } from '../../src/modules/accounting/services/afs/noteGenerators/primaryStatements/equity';
import { generateIncomeStatement } from '../../src/modules/accounting/services/afs/noteGenerators/primaryStatements/incomeStatement';
import { getChangesInEquity } from '../../src/modules/accounting/services/afs/changesInEquityService';
import { fmt } from '../../src/modules/accounting/services/afs/noteGenerators/noteHelpers';

assertDisposable();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const user = crypto.randomUUID();
const t = newTenant();
const dividends = crypto.randomUUID();

async function journal(n: string, date: string, period: string, source: string, amount: number) {
  const entry = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,status,created_by,posted_by,posted_at)
     VALUES($1,$2,$3,$4,$5,'dividend',$6,'posted',$7,$7,now())`, [entry, t.company, n, date, period, source, user]);
  await pool.query(
    `INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,description,company_id)
     VALUES($1,$2,$4,0,'dividend',$5),($1,$3,0,$4,'dividend',$5)`, [entry, dividends, t.acct.bank, amount, t.company]);
}

interface Line { code: string; currentAmount: number; priorAmount: number }
const line = (lines: Line[], code: string) => lines.find((l) => l.code === code)!;

beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `afstakeon-${user}@test.local`]);
  await seedTenant(pool, t, user, 'AFS take-on dividends');
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account,level)
     VALUES($1,$2,'3400','Dividends paid','equity','dividends','debit',true,false,3)`, [dividends, t.company]);
  await pool.query("INSERT INTO afs_account_mappings(company_id,gl_account_id,afs_line_code) VALUES($1,$2,'IS484')", [t.company, dividends]);
  await journal('TAKEON-DIV', '2025-06-30', t.period.p25, 'auto_migration', 200);
  await journal('DIV25', '2025-11-30', t.period.p25, 'manual', 300);
}, 120000);

afterAll(async () => {
  try {
    await cleanupTenant(pool, t);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

describe('dividends in a take-on, across the AFS pack', () => {
  it('IS484 and the AFS SOCE dividends both show only the dividend paid after the take-on', async () => {
    const is = (await generateIncomeStatement(t.company, 2025, 'ifrs_smes')).dataSnapshot.lines as Line[];
    const soce = await generateChangesInEquity(t.company, 2025, 'ifrs_smes');
    expect(line(is, 'IS484').currentAmount).toBe(300);
    expect(soce.dataSnapshot.dividendsPaid).toBe(line(is, 'IS484').currentAmount);
  });

  it('the AFS SOCE shows the take-on in its own column, not inside Movement, and still closes on the SFP', async () => {
    const soce = await generateChangesInEquity(t.company, 2025, 'ifrs_smes');
    const table = soce.content.blocks.find((x) => x.type === 'table') as { headers: string[]; rows: string[][] };
    const takenOn = table.headers.indexOf('Balances taken on (R)');
    const paid = table.headers.indexOf('Dividends (R)');
    expect(takenOn).toBeGreaterThan(0);
    const accumulated = table.rows.find((r) => r[0] === 'Accumulated profit (loss)')!;
    expect(accumulated[takenOn]).toBe(fmt(-200));
    expect(accumulated[paid]).toBe(fmt(-300));
    // Opening 400 (FY2024's profit), taken on -200, dividends -300, movement 1100 (profit 1050 + the fixture's
    // 50 transfer): closing 1000.
    expect(accumulated.slice(1)).toEqual([fmt(400), fmt(-200), fmt(-300), fmt(1100), fmt(1000)]);
    const sfp = (await generateStatementOfFinancialPosition(t.company, 2025, 'ifrs_smes')).dataSnapshot as { totalEquity: number };
    expect(soce.dataSnapshot.closingTotalEquity).toBe(sfp.totalEquity);
  });

  it('the report SOCE agrees: 300 dividends, 200 taken on', async () => {
    const report = await getChangesInEquity(t.company, '2025-01-01', '2025-12-31');
    const re = report.columns.find((c) => c.subtype === 'retained_earnings')!;
    expect(re.takeOn).toBe(-200);
    expect(report.totalDividends).toBe(-300 + 50); // and the fixture's 50 transfer onto retained earnings
  });
});
