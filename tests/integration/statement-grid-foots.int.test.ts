// tests/integration/statement-grid-foots.int.test.ts
/**
 * The grid foots. For two real tenants, every figure the grid renders is a
 * figure the service returned, and the statement reconciles top to bottom.
 * Deliberately fails (not skips) without a real DATABASE_URL: a footing test
 * that can pass by not running is not a footing test. vitest.integration.config.ts
 * substitutes a `dummy.neon.tech` placeholder when the env var is unset, so an
 * absent DATABASE_URL is detected by looking for that placeholder too.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { getIncomeStatement } from '@/modules/accounting/services/reports/incomeStatementService';
import { getBalanceSheet } from '@/modules/accounting/services/reports/balanceSheetService';
import { toIncomeStatementRows } from '@/modules/accounting/services/reports/statementRows/incomeStatementRows';
import { toBalanceSheetRows } from '@/modules/accounting/services/reports/statementRows/balanceSheetRows';
import { IncomeStatementBlock } from '@/components/accounting/afs/AfsStatementsTab';
import { formatMoney } from '@/lib/format/money';

const TENANTS = [
  { name: 'ISAFlow Demo', id: '00000000-0000-0000-0000-000000000001' },
  { name: 'Brightsphere (Britech)', id: 'd27bac33-cdc0-4e58-bf6b-709c1597d41c' },
];
const PERIOD = { start: '2026-03-01', end: '2026-08-31' };
const PRIOR_PERIOD = { start: '2025-03-01', end: '2025-08-31' };

beforeAll(() => {
  const url = process.env.DATABASE_URL;
  if (!url || url.includes('dummy.neon.tech')) {
    throw new Error('statement-grid-foots requires a real DATABASE_URL; it does not skip');
  }
});

const numbersIn = (v: unknown, out = new Set<number>()): Set<number> => {
  if (typeof v === 'number') out.add(Math.round(v * 100));
  else if (Array.isArray(v)) v.forEach(x => numbersIn(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach(x => numbersIn(x, out));
  return out;
};

describe.each(TENANTS)('$name', ({ id }) => {
  it('income statement: every grid figure is a service figure, and the statement reconciles', async () => {
    const r = await getIncomeStatement(id, PERIOD.start, PERIOD.end, {}, PRIOR_PERIOD);
    const service = numbersIn(r);
    for (const row of toIncomeStatementRows(r, { comparative: true })) {
      expect(service, row.label).toContain(Math.round(row.actual * 100));
      if (row.prior !== undefined) expect(service, `${row.label} prior`).toContain(Math.round(row.prior.value * 100));
    }
    expect(r.totalRevenue - r.totalCostOfSales).toBeCloseTo(r.grossProfit, 2);
    expect(r.grossProfit + r.totalOtherIncome - r.totalOperatingExpenses).toBeCloseTo(r.operatingProfit, 2);
    expect(r.operatingProfit - r.totalOtherExpenses).toBeCloseTo(r.netProfit, 2);
    // Assert against the rendered Net Profit CELL. Stripping every non-digit
    // from the whole page and looking for a substring matches by accident on a
    // long statement.
    const html = renderToStaticMarkup(IncomeStatementBlock({ report: r, periodStart: PERIOD.start, periodEnd: PERIOD.end }));
    const grandRow = html.match(/<tr[^>]*data-kind="grand"[^>]*>[\s\S]*?<\/tr>/);
    expect(grandRow, 'the statement has a grand-total row').toBeTruthy();
    expect(grandRow![0]).toContain(formatMoney(r.netProfit, { cents: true }));
  });

  it('balance sheet: grid figures are service figures and A = L + E', async () => {
    const r = await getBalanceSheet(id, PERIOD.end);
    const service = numbersIn(r);
    const { assets, liabilitiesAndEquity } = toBalanceSheetRows(r, { comparative: false });
    for (const row of [...assets, ...liabilitiesAndEquity]) {
      if (row.id === 'grand:totalLiabilitiesAndEquity') continue; // the one derived figure
      expect(service, row.label).toContain(Math.round(row.actual * 100));
    }
    expect(r.totalAssets).toBeCloseTo(r.totalLiabilities + r.totalEquity, 2);
  });
});
