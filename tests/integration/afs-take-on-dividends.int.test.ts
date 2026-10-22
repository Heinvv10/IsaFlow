/**
 * PR #768 round 8 (review M1): the AFS pack reads dividends in a take-on
 * journal (gl/takeOnJournalSource) the same way everywhere. A take-on carries
 * them in as a balance, so the income statement's IS484 "Dividends paid" (and
 * the IS485 running total built on it) leaves them out, the AFS SOCE shows
 * them in a "Balances taken on" column rather than inside Movement, and the
 * report SOCE agrees; a dividend paid after the take-on is a dividend in all
 * three. The SOCE still closes on the SFP's equity.
 *
 * Round 9 (review M1): a take-on is opening for the income statement's
 * accumulated chain too. Its "Balances taken on" line puts the take-on into
 * IS485 in the take-on year, so IS485 still agrees with the SFP's BS045 and
 * the next year's ISACCBF ("beginning of year") equals this year's IS485.
 *
 * Twin G-01 fixture tenants with a debit-normal "Dividends paid" equity
 * account mapped to IS484 and 300 of dividends paid on 2025-11-30. TAKE also
 * has a take-on journal on 2025-06-30 carrying in 500 of retained earnings
 * and 200 of dividends (against the bank); BASE has none. The G-01 fixture
 * leaves expenses unmapped and moves 50 onto retained earnings in FY2025 by
 * design, so IS485 and BS045 differ by that much in BOTH twins; the take-on
 * must not change the difference.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { newTenant, seedTenant, cleanupTenant, type G01Tenant } from './helpers/g01Fixture';
import { generateStatementOfFinancialPosition } from '../../src/modules/accounting/services/afs/noteGenerators/primaryStatements/balanceSheet';
import { generateChangesInEquity } from '../../src/modules/accounting/services/afs/noteGenerators/primaryStatements/equity';
import { generateIncomeStatement } from '../../src/modules/accounting/services/afs/noteGenerators/primaryStatements/incomeStatement';
import { getChangesInEquity } from '../../src/modules/accounting/services/afs/changesInEquityService';
import { fmt } from '../../src/modules/accounting/services/afs/noteGenerators/noteHelpers';

assertDisposable();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const user = crypto.randomUUID();
const t = newTenant();
const base = newTenant();
const dividends: Record<string, string> = { [t.company]: crypto.randomUUID(), [base.company]: crypto.randomUUID() };

async function journal(tenant: G01Tenant, n: string, date: string, period: string, source: string, lines: Array<[string, number, number]>) {
  const entry = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,status,created_by,posted_by,posted_at)
     VALUES($1,$2,$3,$4,$5,'dividend',$6,'posted',$7,$7,now())`, [entry, tenant.company, n, date, period, source, user]);
  for (const [account, debit, credit] of lines) {
    await pool.query(
      `INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,description,company_id) VALUES($1,$2,$3,$4,'line',$5)`,
      [entry, account, debit, credit, tenant.company]);
  }
}

interface Line { code: string; currentAmount: number; priorAmount: number }
const line = (lines: Line[], code: string) => lines.find((l) => l.code === code) ?? { code, currentAmount: 0, priorAmount: 0 };

beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `afstakeon-${user}@test.local`]);
  for (const [tenant, name] of [[t, 'AFS take-on dividends'], [base, 'AFS take-on dividends (no take-on)']] as const) {
    await seedTenant(pool, tenant, user, name);
    const div = dividends[tenant.company]!;
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account,level)
       VALUES($1,$2,'3400','Dividends paid','equity','dividends','debit',true,false,3)`, [div, tenant.company]);
    await pool.query("INSERT INTO afs_account_mappings(company_id,gl_account_id,afs_line_code) VALUES($1,$2,'IS484')", [tenant.company, div]);
    await journal(tenant, 'DIV25', '2025-11-30', tenant.period.p25, 'manual', [[div, 300, 0], [tenant.acct.bank, 0, 300]]);
  }
  // The take-on: 500 of prior retained earnings and 200 of dividends, carried in against the bank.
  await journal(t, 'TAKEON', '2025-06-30', t.period.p25, 'auto_migration',
    [[t.acct.bank, 300, 0], [dividends[t.company]!, 200, 0], [t.acct.retained, 0, 500]]);
}, 120000);

afterAll(async () => {
  try {
    await cleanupTenant(pool, t);
    await cleanupTenant(pool, base);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

const isLines = async (tenant: G01Tenant, year: number) => (await generateIncomeStatement(tenant.company, year, 'ifrs_smes')).dataSnapshot.lines as Line[];
const sfpLines = async (tenant: G01Tenant, year: number) => ((await generateStatementOfFinancialPosition(tenant.company, year, 'ifrs_smes')).dataSnapshot as { lines: Line[] }).lines;

describe('dividends in a take-on, across the AFS pack', () => {
  it('IS484 and the AFS SOCE dividends both show only the dividend paid after the take-on', async () => {
    const is = await isLines(t, 2025);
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
    expect(accumulated[takenOn]).toBe(fmt(500 - 200));
    expect(accumulated[paid]).toBe(fmt(-300));
    // Opening 400 (FY2024's profit), taken on +300 (500 retained earnings less 200 dividends), dividends -300,
    // movement 1100 (profit 1050 + the fixture's 50 transfer): closing 1500.
    expect(accumulated.slice(1)).toEqual([fmt(400), fmt(300), fmt(-300), fmt(1100), fmt(1500)]);
    const sfp = (await generateStatementOfFinancialPosition(t.company, 2025, 'ifrs_smes')).dataSnapshot as { totalEquity: number };
    expect(soce.dataSnapshot.closingTotalEquity).toBe(sfp.totalEquity);
  });

  it('the report SOCE agrees: 300 dividends, 300 taken on (500 less 200)', async () => {
    const report = await getChangesInEquity(t.company, '2025-01-01', '2025-12-31');
    const re = report.columns.find((c) => c.subtype === 'retained_earnings')!;
    expect(re.takeOn).toBe(300);
    expect(report.totalDividends).toBe(-300 + 50); // and the fixture's 50 transfer onto retained earnings
  });

  // Raw debit-minus-credit, as both statements' snapshots hold them.
  const gap = async (tenant: G01Tenant, year: number) => line(await isLines(tenant, year), 'IS485').currentAmount - line(await sfpLines(tenant, year), 'BS045').currentAmount;

  it('in the take-on year IS485 agrees with BS045 as closely as without a take-on: the take-on is in the chain', async () => {
    const is = await isLines(t, 2025);
    expect(line(is, 'ISTAKEON').currentAmount).toBe(-300); // 500 retained earnings less 200 dividends, credit-positive 300
    // Printed credit-positive like the opening line above it, not as a negative.
    const table = (await generateIncomeStatement(t.company, 2025, 'ifrs_smes')).content.blocks
      .find((x) => x.type === 'table') as { rows: string[][] };
    expect(table.rows.find((r) => r[0] === 'Balances taken on')?.[1]).toBe(fmt(300));
    expect(await gap(t, 2025)).toBe(await gap(base, 2025));
  });

  it('a company with no take-on has an ISTAKEON of 0 and prints no "Balances taken on" row', async () => {
    const derived = (await isLines(base, 2025)).find((l) => l.code === 'ISTAKEON');
    expect(derived).toBeDefined();
    expect(derived!.currentAmount).toBeCloseTo(0, 2);
    const table = (await generateIncomeStatement(base.company, 2025, 'ifrs_smes')).content.blocks
      .find((x) => x.type === 'table') as { rows: string[][] };
    expect(table.rows.some((r) => r[0]!.includes('Balances taken on'))).toBe(false);
    expect(table.rows.some((r) => r[0]!.includes('Accumulated income (loss) end of year'))).toBe(true); // the chain is printed
  });

  it('the next year opens on the take-on year\'s close: ISACCBF equals the prior year\'s IS485, on the same page', async () => {
    for (const tenant of [t, base]) {
      const is26 = await isLines(tenant, 2026);
      const is25 = await isLines(tenant, 2025);
      expect(line(is26, 'IS485').priorAmount).toBe(line(is25, 'IS485').currentAmount);
      expect(line(is26, 'ISTAKEON').currentAmount).toBeCloseTo(0, 2); // no take-on in FY2026
    }
    // The opening difference (what the fixture leaves unmapped) is the twins', not the take-on's.
    const open = async (tenant: G01Tenant) => {
      const is26 = await isLines(tenant, 2026);
      return line(is26, 'ISACCBF').currentAmount - line(is26, 'IS485').priorAmount;
    };
    expect(await open(t)).toBe(await open(base));
    expect(await gap(t, 2026)).toBe(await gap(base, 2026));
  });
});
