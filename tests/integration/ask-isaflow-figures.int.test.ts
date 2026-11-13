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

  it('profit last month equals the income statement the page reads', async () => {
    const direct = await getIncomeStatement(S.A, '2026-10-01', '2026-10-31');
    const a = await ask(S.A, 'what is my profit last month');
    expect(direct.netProfit).toBe(ASK_AMOUNTS.A.sale - ASK_AMOUNTS.A.expense);
    expect(a.figure).toBe(direct.netProfit);
    expect(a.link?.href).toBe('/accounting/reports/income-statement?period_start=2026-10-01&period_end=2026-10-31');
  });

  it('revenue and expenses last month equal the statement totals', async () => {
    const direct = await getIncomeStatement(S.A, '2026-10-01', '2026-10-31');
    expect((await ask(S.A, 'what is my revenue last month')).figure).toBe(direct.totalRevenue);
    expect((await ask(S.A, 'what are my expenses last month')).figure)
      .toBe(direct.totalCostOfSales + direct.totalOperatingExpenses + direct.totalOtherExpenses);
  });

  it('total assets as at the end of last month equals the balance sheet', async () => {
    const direct = await getBalanceSheet(S.A, '2026-10-31');
    const a = await ask(S.A, 'what are my total assets last month');
    expect(direct.totalAssets).not.toBe(0);
    expect(a.figure).toBe(direct.totalAssets);
    expect((await ask(S.A, 'what are my total liabilities last month')).figure).toBe(direct.totalLiabilities);
  });

  it('VAT for October is the company\'s Sep-Oct VAT period, equal to the VAT201 report', async () => {
    const direct = await getVat201Report(S.A, '2026-09-01', '2026-10-31', { detail: 'summary' });
    const a = await ask(S.A, 'what vat do I owe for october');
    expect(direct.totals.netVat).toBe(ASK_AMOUNTS.A.sale * 0.15);
    expect(a.figure).toBe(direct.totals.netVat);
    expect(a.link?.href).toBe('/accounting/sars/vat201?from=2026-09-01&to=2026-10-31');
  });

  it('EMP201 for October equals the service total', async () => {
    const direct = await generateEMP201(S.A, '2026-10-01', '2026-10-31');
    const a = await ask(S.A, 'what do I owe sars for payroll in october');
    expect(direct.totalDeductions).toBeGreaterThan(0);
    expect(a.figure).toBe(direct.totalDeductions);
  });

  it('the last pay run is the approved one, not the later draft re-run', async () => {
    const a = await ask(S.A, 'what did the last pay run cost');
    expect(a.figure).toBe(ASK_AMOUNTS.A.gross);
    expect((await ask(S.A, 'what did payroll cost last month')).figure).toBe(ASK_AMOUNTS.A.gross);
  });

  it('tenant B\'s answers are B\'s own, and none of B\'s figures appear in A\'s', async () => {
    const questions = ['what is my profit last month', 'what are my total assets last month', 'what vat do I owe for october',
      'what do I owe sars for payroll in october', 'what did the last pay run cost', 'who owes me money'];
    for (const q of questions) {
      const a = await ask(S.A, q);
      const b = await ask(S.B, q);
      if (q !== 'who owes me money') expect(b.figure, q).not.toBe(a.figure);
      for (const leak of [ASK_AMOUNTS.B.sale, ASK_AMOUNTS.B.gross, ASK_AMOUNTS.B.sale * 0.15, ASK_AMOUNTS.B.sale - ASK_AMOUNTS.B.expense]) {
        expect(JSON.stringify(a), `${q}: B's ${leak} in A's answer`).not.toContain(String(leak));
      }
    }
    expect((await ask(S.B, 'what did the last pay run cost')).figure).toBe(ASK_AMOUNTS.B.gross);
  });
});
