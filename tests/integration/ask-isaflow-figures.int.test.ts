// tests/integration/ask-isaflow-figures.int.test.ts
//
// "Ask IsaFlow" (wave 5 M11) against a real database: each answer's figure equals a DIRECT call of the service behind
// its page, and tenant B's data (ten times A's) never reaches tenant A's answer. Fixture: tests/helpers/askScopeFixture.ts.
// "Today" is passed in (2026-11-13) so the windows are fixed: last month is October, the VAT period Sep-Oct.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { ASK_AMOUNTS, dropAskScope, newAskScope, seedAskScope } from '../helpers/askScopeFixture';
import { answerQuestion } from '@/modules/accounting/services/ask/askAnswer';
import { getIncomeStatement } from '@/modules/accounting/services/reports/financialReportingService';
import { getBalanceSheet } from '@/modules/accounting/services/reports/balanceSheetService';
import { getVat201Report } from '@/modules/accounting/services/reports/vat201ReportService';
import { generateEMP201 } from '@/modules/accounting/services/reports/emp201Service';
import { getARAging } from '@/modules/accounting/services/ar/arAgingService';
import { getAPAging } from '@/modules/accounting/services/ap/apAgingService';
import { getBankAccountsStatus } from '@/modules/accounting/services/bank/bankAccountStatusService';
import { getCashBalance } from '@/modules/accounting/services/bank/cashBalanceService';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const S = newAskScope();
const TODAY = '2026-11-13';
const ask = (co: string, q: string) => answerQuestion(co, q, TODAY);

describeIfDb('Ask IsaFlow answers equal the services behind the pages, per tenant', () => {
  let admin: Pool;
  beforeAll(async () => {
    assertNotProductionDb('This test inserts and deletes company, ledger and payroll fixtures.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await seedAskScope(admin, S);
  }, 60000);
  afterAll(async () => {
    if (!admin) return;
    await dropAskScope(admin, S);
    await admin.end();
  }, 60000);

  const A = ASK_AMOUNTS.A;
  const B = ASK_AMOUNTS.B;

  it('profit last month equals the income statement the page reads, and leaves November out', async () => {
    const direct = await getIncomeStatement(S.A, '2026-10-01', '2026-10-31');
    const a = await ask(S.A, 'what is my profit last month');
    expect(direct.netProfit).toBe(A.sale - A.expense - A.financeCost);
    expect(a.figure).toBe(direct.netProfit);
    expect(a.link?.href).toBe('/accounting/reports/income-statement?period_start=2026-10-01&period_end=2026-10-31');
    const nov = await getIncomeStatement(S.A, '2026-11-01', '2026-11-13');
    expect((await ask(S.A, 'what is my profit this month')).figure).toBe(nov.netProfit);
    expect(nov.netProfit).toBe(A.novSale - A.novExpense);
  });

  it('revenue and expenses last month equal the statement totals, other expenses included', async () => {
    const direct = await getIncomeStatement(S.A, '2026-10-01', '2026-10-31');
    expect(direct.totalOtherExpenses).toBe(A.financeCost);
    expect((await ask(S.A, 'what is my revenue last month')).figure).toBe(direct.totalRevenue);
    expect((await ask(S.A, 'what are my expenses last month')).figure)
      .toBe(direct.totalCostOfSales + direct.totalOperatingExpenses + direct.totalOtherExpenses);
  });

  it('total assets are as at the date asked: end of last month, or today', async () => {
    const lastMonth = await getBalanceSheet(S.A, '2026-10-31');
    const today = await getBalanceSheet(S.A, TODAY);
    expect(lastMonth.totalAssets).not.toBe(today.totalAssets);
    expect((await ask(S.A, 'what are my total assets last month')).figure).toBe(lastMonth.totalAssets);
    expect((await ask(S.A, 'what are my total assets')).figure).toBe(today.totalAssets);
    expect((await ask(S.A, 'what are my total liabilities last month')).figure).toBe(lastMonth.totalLiabilities);
  });

  it('total assets as at a mid-month day is that day, not the month end', async () => {
    const day = await getBalanceSheet(S.A, '2026-10-11');
    const monthEnd = await getBalanceSheet(S.A, '2026-10-31');
    expect(day.totalAssets).not.toBe(monthEnd.totalAssets);
    expect((await ask(S.A, 'what are my total assets as at 11 october')).figure).toBe(day.totalAssets);
    expect((await ask(S.A, 'what are my total assets as at 31 october')).figure).toBe(monthEnd.totalAssets);
  });

  it('VAT: October is the Sep-Oct period; with no month it is the current Nov-Dec period; each equals the VAT201 report', async () => {
    const sepOct = await getVat201Report(S.A, '2026-09-01', '2026-10-31', { detail: 'summary' });
    const novDec = await getVat201Report(S.A, '2026-11-01', '2026-12-31', { detail: 'summary' });
    expect(sepOct.totals.netVat).toBe(A.sale * 0.15);
    expect(novDec.totals.netVat).toBe(A.novSale * 0.15);
    const oct = await ask(S.A, 'what vat do I owe for october');
    expect(oct.figure).toBe(sepOct.totals.netVat);
    expect(oct.link?.href).toBe('/accounting/sars/vat201?from=2026-09-01&to=2026-10-31');
    expect((await ask(S.A, 'what vat do I owe')).figure).toBe(novDec.totals.netVat);
  });

  it('EMP201 equals the service total for the month asked', async () => {
    for (const [q, from, to] of [['what do I owe sars for payroll in october', '2026-10-01', '2026-10-31'], ['what do I owe sars for payroll in september', '2026-09-01', '2026-09-30']] as const) {
      const direct = await generateEMP201(S.A, from, to);
      expect(direct.totalDeductions).toBeGreaterThan(0);
      expect((await ask(S.A, q)).figure, q).toBe(direct.totalDeductions);
    }
  });

  it('the last pay run is the latest DECLARABLE month: a later approved run beats an earlier one, later draft and calculated runs are ignored; a named month is that month', async () => {
    expect((await ask(S.A, 'what did the last pay run cost')).figure).toBe(A.gross);
    expect((await ask(S.A, 'what did payroll cost last month')).figure).toBe(A.gross);
    expect((await ask(S.A, 'what did payroll cost for september')).figure).toBe(A.sepGross);
  });

  it('who owes me and who I owe equal the aging services', async () => {
    const ar = (await getARAging(S.A, TODAY)).reduce((t, b) => t + b.total, 0);
    const ap = (await getAPAging(S.A, TODAY)).reduce((t, b) => t + b.total, 0);
    expect(ar).toBe(A.ar);
    expect(ap).toBe(A.ap);
    expect((await ask(S.A, 'who owes me money')).figure).toBe(ar);
    expect((await ask(S.A, 'who do I owe')).figure).toBe(ap);
  });

  it('cash in the bank is the ACTIVE accounts on the statement basis; inactive listed apart; ledger cash shown', async () => {
    const status = await getBankAccountsStatus(S.A, { includeInactive: true });
    const active = status.filter((x) => x.isActive);
    expect(status).toHaveLength(3);
    const a = await ask(S.A, 'how much cash is in the bank');
    expect(a.figure).toBe(A.bankA + A.bankB);
    expect(a.figure).toBe(active.reduce((t, x) => t + x.balance, 0));
    expect(a.lines.find((l) => l.label.includes('inactive'))?.value).toBe(A.bankInactive);
    expect(a.lines.find((l) => l.label.startsWith('Ledger cash'))?.value).toBe((await getCashBalance(S.A, TODAY)).total);
    expect((await ask(S.A, 'how many bank transactions need allocating')).figure).toBe(active.reduce((t, x) => t + x.unallocatedCount, 0));
  });

  it('tenant B\'s answers are B\'s own, and none of B\'s figures appear in A\'s', async () => {
    const questions = ['what is my profit last month', 'what are my total assets last month', 'what vat do I owe for october',
      'what do I owe sars for payroll in october', 'what did the last pay run cost', 'who owes me money', 'who do I owe',
      'how much cash is in the bank', 'how many bank transactions need allocating', 'what are my expenses last month'];
    const leaks = [B.sale, B.gross, B.sale * 0.15, B.sale - B.expense - B.financeCost, B.ar, B.ap, B.bankA, B.bankA + B.bankB, B.bankInactive, B.financeCost, B.sepGross];
    for (const q of questions) {
      const a = await ask(S.A, q);
      const b = await ask(S.B, q);
      if (q !== 'how many bank transactions need allocating') expect(b.figure, q).not.toBe(a.figure);
      for (const leak of leaks) expect(JSON.stringify(a), `${q}: B's ${leak} in A's answer`).not.toMatch(new RegExp(`(?<![\\d.])${String(leak).replace('.', '\\.')}(?![\\d])`));
    }
    expect((await ask(S.B, 'what did the last pay run cost')).figure).toBe(B.gross);
    expect((await ask(S.B, 'how much cash is in the bank')).figure).toBe(B.bankA + B.bankB);
    expect((await ask(S.B, 'who owes me money')).figure).toBe(B.ar);
  });
});
