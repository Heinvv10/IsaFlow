/**
 * Dividends paid on an equity account mapped to IS484 "Dividends paid" reach balance-sheet equity and the
 * statement of changes in equity, so the AFS balances with dividends declared.
 *
 * Twin tenants on the G-01 fixture, identical but for where the dividends go:
 *  - DIV: a debit-normal equity account "Dividends paid" (subtype 'dividends'), mapped to IS484;
 *  - RE:  the same payments debited straight to retained earnings (mapped to BS045), which the SFP already
 *         reads, so its figures are the ground truth DIV must equal.
 * Dividends: 100 on 2024-12-15 (FY2024), 300 on 2025-11-30 (FY2025), both paid from the bank. Before the
 * fix DIV's SFP left the dividends out of equity (equity 11450 against net assets 11050), its SOCE had no
 * dividends, and the pre-export check warned about the mapping.
 *
 * Each assertion runs before the year-end close and again after FY2024 and FY2025 are closed (the posted
 * close is skipped by every AFS reader, so nothing may change).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { newTenant, seedTenant, cleanupTenant, type G01Tenant } from './helpers/g01Fixture';
import { closeFiscalYear } from '../../src/modules/accounting/services/gl/yearEndCloseService';
import { generateStatementOfFinancialPosition } from '../../src/modules/accounting/services/afs/noteGenerators/primaryStatements/balanceSheet';
import { generateChangesInEquity } from '../../src/modules/accounting/services/afs/noteGenerators/primaryStatements/equity';
import { generateIncomeStatement } from '../../src/modules/accounting/services/afs/noteGenerators/primaryStatements/incomeStatement';
import { getChangesInEquity } from '../../src/modules/accounting/services/afs/changesInEquityService';
import { runPreExportChecks } from '../../src/modules/accounting/services/afs/afsPreExportChecks';
import { fmt } from '../../src/modules/accounting/services/afs/noteGenerators/noteHelpers';
import { createAccount } from '../../src/modules/accounting/services/gl/chartOfAccountsService';
import { autoMapAccounts } from '../../src/modules/accounting/services/afs/afsAutoMapper';

assertDisposable();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const user = crypto.randomUUID();
const div = newTenant();
const re = newTenant();
const dividendsAccount = crypto.randomUUID();
const MAPPING_LABEL = 'Every mapped account is on the right statement';

// Bank 10400 at the end of FY2024 and 16450 at the end of FY2025 before dividends (g01Fixture), loan 5000.
const EXPECTED = { assets25: 16050, liabilities25: 5000, equity25: 11050, assets24: 10300, equity24: 10300 };

async function pay(t: G01Tenant, debit: string, n: string, date: string, period: string, amount: number) {
  const entry = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,status,created_by,posted_by,posted_at)
     VALUES($1,$2,$3,$4,$5,'dividend','manual','posted',$6,$6,now())`, [entry, t.company, n, date, period, user]);
  await pool.query(
    `INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,description,company_id)
     VALUES($1,$2,$4,0,'dividend',$5),($1,$3,0,$4,'dividend',$5)`, [entry, debit, t.acct.bank, amount, t.company]);
}

interface Line { code: string; currentAmount: number; priorAmount: number }
interface Sfp { totalAssets: number; totalLiabilities: number; totalEquity: number; lines: Line[] }
const sfpOf = async (t: G01Tenant) => (await generateStatementOfFinancialPosition(t.company, 2025, 'ifrs_smes')).dataSnapshot as unknown as Sfp;
const line = (lines: Line[], code: string) => lines.find((l) => l.code === code)!;

beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `afsdiv-${user}@test.local`]);
  await seedTenant(pool, div, user, 'AFS dividends (IS484 account)');
  await seedTenant(pool, re, user, 'AFS dividends (retained earnings)');
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account,level)
     VALUES($1,$2,'3400','Dividends paid','equity','dividends','debit',true,false,3)`, [dividendsAccount, div.company]);
  await pool.query("INSERT INTO afs_account_mappings(company_id,gl_account_id,afs_line_code) VALUES($1,$2,'IS484')", [div.company, dividendsAccount]);
  await pay(div, dividendsAccount, 'DIV24', '2024-12-15', div.period.p24, 100);
  await pay(div, dividendsAccount, 'DIV25', '2025-11-30', div.period.p25, 300);
  await pay(re, re.acct.retained, 'DIV24', '2024-12-15', re.period.p24, 100);
  await pay(re, re.acct.retained, 'DIV25', '2025-11-30', re.period.p25, 300);
}, 120000);

afterAll(async () => {
  try {
    await cleanupTenant(pool, div);
    await cleanupTenant(pool, re);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

async function expectDividendsCarried(): Promise<void> {
  // The Statement of Financial Position balances, and equals the twin's line for line on equity.
  const [a, b] = [await sfpOf(div), await sfpOf(re)];
  for (const s of [a, b]) {
    expect(s.totalAssets).toBe(EXPECTED.assets25);
    expect(s.totalLiabilities).toBe(EXPECTED.liabilities25);
    expect(s.totalEquity).toBe(EXPECTED.equity25);
    expect(s.totalAssets).toBe(s.totalLiabilities + s.totalEquity);
    expect(line(s.lines, 'BS038').priorAmount).toBe(EXPECTED.assets24);
    expect(-line(s.lines, 'BS048').priorAmount).toBe(EXPECTED.equity24);
  }
  expect(line(a.lines, 'BS045')).toMatchObject({ currentAmount: line(b.lines, 'BS045').currentAmount, priorAmount: line(b.lines, 'BS045').priorAmount });

  // The AFS statement of changes in equity shows the year's dividends on the accumulated-profit row and closes
  // on the SFP's equity.
  const soce = await generateChangesInEquity(div.company, 2025, 'ifrs_smes');
  expect(soce.dataSnapshot.dividendsPaid).toBe(300);
  expect(soce.dataSnapshot.closingTotalEquity).toBe(EXPECTED.equity25);
  const table = soce.content.blocks.find((x) => x.type === 'table') as { headers: string[]; rows: string[][] };
  const col = table.headers.indexOf('Dividends (R)');
  expect(col).toBeGreaterThan(0);
  const accumulated = table.rows.find((r) => r[0] === 'Accumulated profit (loss)')!;
  expect(accumulated[col]).toBe(fmt(-300));
  // Opening + dividends + other movement = closing on that row: 300 - 300 + 1100 (profit 1050, transfer 50) = 1100.
  expect(accumulated.slice(1)).toEqual([fmt(300), fmt(-300), fmt(1100), fmt(1100)]);
  expect((await generateChangesInEquity(re.company, 2025, 'ifrs_smes')).dataSnapshot.closingTotalEquity).toBe(EXPECTED.equity25);

  // The report statement of changes in equity: the dividends account is a distribution out of retained
  // earnings (not a column of its own under "other movements"), so both twins report the same figures.
  const [ra, rb] = [await getChangesInEquity(div.company, '2025-01-01', '2025-12-31'), await getChangesInEquity(re.company, '2025-01-01', '2025-12-31')];
  expect(ra.columns.map((c) => c.subtype)).not.toContain('dividends');
  expect(ra.totalOtherMovements).toBe(0);
  for (const r of [ra, rb]) {
    // -300 paid, +50 the fixture's capital-to-retained-earnings transfer (a movement on retained earnings).
    expect(r.totalDividends).toBe(-250);
    expect(r.totalProfitForYear).toBe(1050);
    expect(r.totalOpening).toBe(EXPECTED.equity24);
    expect(r.totalClosing).toBe(EXPECTED.equity25);
  }

  // The income statement shows the dividends on IS484, and its accumulated income takes every earlier
  // year's dividends off the opening balance: FY2024 400 - 100 = 300 brought forward, + 1350 - 300 (the
  // income statement's FY2025 profit is 1350: the fixture leaves 300 of expenses unmapped).
  const is = (await generateIncomeStatement(div.company, 2025, 'ifrs_smes')).dataSnapshot.lines as Line[];
  expect(line(is, 'IS484')).toMatchObject({ currentAmount: 300, priorAmount: 100 });
  expect(line(is, 'ISACCBF').currentAmount).toBe(-300);
  expect(line(is, 'IS485')).toMatchObject({ currentAmount: -1350, priorAmount: -300 });

  // The mapping is now carried, so the pre-export check no longer warns about it.
  expect((await runPreExportChecks(div.doc, div.company, 'ifrs_smes')).find((c) => c.label === MAPPING_LABEL)).toBeUndefined();
}

describe('dividends paid on an equity account mapped to IS484', () => {
  it('reach SFP equity, the statements of changes in equity and accumulated income; the twins agree', async () => {
    await expectDividendsCarried();
  });

  it('and nothing changes once both years are closed', async () => {
    for (const t of [div, re]) {
      await closeFiscalYear(t.company, '2024', user);
      await closeFiscalYear(t.company, '2025', user);
    }
    await expectDividendsCarried();
  }, 60000);

  it('a NON-equity account on IS484 is still named by the pre-export check', async () => {
    await pool.query("UPDATE afs_account_mappings SET afs_line_code='IS484' WHERE company_id=$1 AND gl_account_id=$2", [div.company, div.acct.loan]);
    const finding = (await runPreExportChecks(div.doc, div.company, 'ifrs_smes')).find((c) => c.label === MAPPING_LABEL);
    expect(finding?.detail).toMatch(/2000 Loan \(liability\) is mapped to IS484, an income statement line/);
    expect(finding?.detail).not.toMatch(/3400/);
    await pool.query("UPDATE afs_account_mappings SET afs_line_code='BS054' WHERE company_id=$1 AND gl_account_id=$2", [div.company, div.acct.loan]);
  });

  it('an EXPENSE account on IS484 is not taken off equity again (it is already inside the derived profit)', async () => {
    await pool.query("INSERT INTO afs_account_mappings(company_id,gl_account_id,afs_line_code) VALUES($1,$2,'IS484')", [div.company, div.acct.dep]);
    try {
      expect((await sfpOf(div)).totalEquity).toBe(EXPECTED.equity25);
      expect((await generateChangesInEquity(div.company, 2025, 'ifrs_smes')).dataSnapshot.dividendsPaid).toBe(300);
    } finally {
      await pool.query('DELETE FROM afs_account_mappings WHERE company_id=$1 AND gl_account_id=$2', [div.company, div.acct.dep]);
    }
  });

  it('a CREDIT-normal equity account on IS484 (share capital) is not a dividends account: named, never carried', async () => {
    const before = line((await sfpOf(div)).lines, 'BS045');
    await pool.query("UPDATE afs_account_mappings SET afs_line_code='IS484' WHERE company_id=$1 AND gl_account_id=$2", [div.company, div.acct.capital]);
    try {
      const s = await sfpOf(div);
      expect(line(s.lines, 'BS045')).toMatchObject({ currentAmount: before.currentAmount, priorAmount: before.priorAmount });
      // Off its own line and not carried: the balance-sheet blocker sees the gap, and the mapping check names why.
      expect(s.totalAssets).not.toBe(s.totalLiabilities + s.totalEquity);
      const finding = (await runPreExportChecks(div.doc, div.company, 'ifrs_smes')).find((c) => c.label === MAPPING_LABEL);
      expect(finding?.detail).toMatch(/3000 Share capital \(equity\) is mapped to IS484/);
      expect((await generateChangesInEquity(div.company, 2025, 'ifrs_smes')).dataSnapshot.dividendsPaid).toBe(300);
      // The report SOCE keeps share capital in its own column with its own movements, and accumulated income does
      // not take its 10000 in as an earlier year's dividend.
      const report = await getChangesInEquity(div.company, '2025-01-01', '2025-12-31');
      expect(report.columns.find((c) => c.subtype === 'share_capital')).toMatchObject({ opening: 10000, shareIssue: -50 });
      expect(report.totalDividends).toBe(-250);
      const is = (await generateIncomeStatement(div.company, 2025, 'ifrs_smes')).dataSnapshot.lines as Line[];
      expect(line(is, 'ISACCBF').currentAmount).toBe(-300);
    } finally {
      await pool.query("UPDATE afs_account_mappings SET afs_line_code='BS043' WHERE company_id=$1 AND gl_account_id=$2", [div.company, div.acct.capital]);
    }
  });

  it('clearing the dividends account into retained earnings, inside a larger adjusting journal, is not a distribution', async () => {
    const clearing = crypto.randomUUID();
    await pool.query(
      `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,status,created_by,posted_by,posted_at)
       VALUES($1,$2,'CLR25','2025-12-31',$3,'year-end adjustments','manual','posted',$4,$4,now())`, [clearing, div.company, div.period.p25, user]);
    // The clearing pair, plus a 10 rent accrual in the same journal (so the journal is not equity-only).
    await pool.query(
      `INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,description,company_id)
       VALUES($1,$2,300,0,'clear',$6),($1,$3,0,300,'clear',$6),($1,$4,10,0,'rent',$6),($1,$5,0,10,'rent',$6)`,
      [clearing, div.acct.retained, dividendsAccount, div.acct.expense, div.acct.bank, div.company]);
    try {
      const s = await sfpOf(div);
      expect(s.totalEquity).toBe(EXPECTED.equity25 - 10);
      expect(s.totalAssets).toBe(s.totalLiabilities + s.totalEquity);
      const soce = await generateChangesInEquity(div.company, 2025, 'ifrs_smes');
      expect(soce.dataSnapshot.dividendsPaid).toBe(300);
      expect(soce.dataSnapshot.closingTotalEquity).toBe(EXPECTED.equity25 - 10);
      const table = soce.content.blocks.find((x) => x.type === 'table') as { headers: string[]; rows: string[][] };
      expect(table.rows.find((r) => r[0] === 'Accumulated profit (loss)')!.slice(1)).toEqual([fmt(300), fmt(-300), fmt(1090), fmt(1090)]);
      expect((await getChangesInEquity(div.company, '2025-01-01', '2025-12-31')).totalDividends).toBe(-250);
    } finally {
      await pool.query('DELETE FROM gl_journal_lines WHERE journal_entry_id=$1', [clearing]);
      await pool.query('DELETE FROM gl_journal_entries WHERE id=$1', [clearing]);
    }
  });

  it('a deactivated IS484 line still carries the dividends: is_active does not take a live balance out of equity', async () => {
    await pool.query("UPDATE afs_statement_lines SET is_active=false WHERE company_id=$1 AND code='IS484'", [div.company]);
    try {
      const s = await sfpOf(div);
      expect(s.totalEquity).toBe(EXPECTED.equity25);
      expect(s.totalAssets).toBe(s.totalLiabilities + s.totalEquity);
      expect((await generateChangesInEquity(div.company, 2025, 'ifrs_smes')).dataSnapshot.dividendsPaid).toBe(300);
      expect((await getChangesInEquity(div.company, '2025-01-01', '2025-12-31')).totalClosing).toBe(EXPECTED.equity25);
      // The income statement drops a deactivated line, so the account is reported as unmapped, not passed silently.
      const unmapped = (await runPreExportChecks(div.doc, div.company, 'ifrs_smes')).find((c) => c.label === 'Every ledger account reaches the statements');
      expect(unmapped?.passed).toBe(false);
    } finally {
      await pool.query("UPDATE afs_statement_lines SET is_active=true WHERE company_id=$1 AND code='IS484'", [div.company]);
    }
  });

  it('a distribution credited to another equity account (a members\' current account) is still a dividend paid', async () => {
    const members = crypto.randomUUID();
    const entry = crypto.randomUUID();
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account,level)
       VALUES($1,$2,'3500','Members current account','equity','equity','credit',true,false,3)`, [members, div.company]);
    await pool.query("INSERT INTO afs_account_mappings(company_id,gl_account_id,afs_line_code) VALUES($1,$2,'BS044')", [div.company, members]);
    await pool.query(
      `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,status,created_by,posted_by,posted_at)
       VALUES($1,$2,'DISTM','2025-10-15',$3,'distribution','manual','posted',$4,$4,now())`, [entry, div.company, div.period.p25, user]);
    await pool.query(
      `INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,description,company_id)
       VALUES($1,$2,40,0,'d',$4),($1,$3,0,40,'d',$4)`, [entry, dividendsAccount, members, div.company]);
    try {
      expect((await generateChangesInEquity(div.company, 2025, 'ifrs_smes')).dataSnapshot.dividendsPaid).toBe(340);
      const s = await sfpOf(div);
      expect(s.totalEquity).toBe(EXPECTED.equity25);
    } finally {
      await pool.query('DELETE FROM gl_journal_lines WHERE journal_entry_id=$1', [entry]);
      await pool.query('DELETE FROM gl_journal_entries WHERE id=$1', [entry]);
      await pool.query('DELETE FROM afs_account_mappings WHERE gl_account_id=$1', [members]);
    }
  });

  it('a dividends account carrying the retained_earnings subtype is not read as its own clearing journal', async () => {
    await pool.query("UPDATE gl_accounts SET account_subtype='retained_earnings' WHERE id=$1", [dividendsAccount]);
    try {
      expect((await generateChangesInEquity(div.company, 2025, 'ifrs_smes')).dataSnapshot.dividendsPaid).toBe(300);
      expect((await sfpOf(div)).totalEquity).toBe(EXPECTED.equity25);
    } finally {
      await pool.query("UPDATE gl_accounts SET account_subtype='dividends' WHERE id=$1", [dividendsAccount]);
    }
  });

  // Last: auto-mapping maps the fixture's unmapped accounts too.
  it('an account created in the app (equity is always credit-normal) with subtype dividends is auto-mapped to IS484 and carried', async () => {
    const created = await createAccount(div.company, {
      accountCode: '3450', accountName: 'Dividends declared', accountType: 'equity', accountSubtype: 'dividends', normalBalance: 'credit',
    });
    expect(created.normalBalance).toBe('credit');
    await autoMapAccounts(div.company);
    const mapped = await pool.query('SELECT afs_line_code FROM afs_account_mappings WHERE company_id=$1 AND gl_account_id=$2', [div.company, created.id]);
    expect(mapped.rows[0]?.afs_line_code).toBe('IS484');
    await pay(div, created.id, 'DIV25B', '2025-10-01', div.period.p25, 50);
    const s = await sfpOf(div);
    expect(s.totalEquity).toBe(EXPECTED.equity25 - 50);
    expect(s.totalAssets).toBe(s.totalLiabilities + s.totalEquity);
    expect((await generateChangesInEquity(div.company, 2025, 'ifrs_smes')).dataSnapshot.dividendsPaid).toBe(350);
    expect((await getChangesInEquity(div.company, '2025-01-01', '2025-12-31')).totalDividends).toBe(-300);
    expect((await runPreExportChecks(div.doc, div.company, 'ifrs_smes')).find((c) => c.label === MAPPING_LABEL)).toBeUndefined();
  });
});
