/**
 * Adversarial (PR #1145 fix 2): the KPI scorecard's turnover/gross/net margins equal the Income Statement report's for
 * every subtype spelling, NULL, '', unknown and non-canonical. Both services read the SAME mocked ledger rows.
 */
import { describe, expect, it, vi } from 'vitest';

type L = { code: string; type: 'revenue' | 'expense'; sub: string | null; debit: number; credit: number };
const ledger = vi.hoisted(() => ({ lines: [] as L[] }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    // The pack-month window only: the prior month is empty.
    if (text.includes('GROUP BY ga.account_type, ga.account_subtype') && text.includes("('revenue', 'expense')")) {
      const g = new Map<string, { account_type: string; account_subtype: string | null; debit: number; credit: number }>();
      for (const l of ledger.lines) {
        const k = `${l.type}|${l.sub}`;
        const r = g.get(k) ?? { account_type: l.type, account_subtype: l.sub, debit: 0, credit: 0 };
        r.debit += l.debit; r.credit += l.credit; g.set(k, r);
      }
      return [...g.values()];
    }
    if (text.includes('ga.account_code, ga.account_name, ga.account_type, ga.account_subtype')) {
      return ledger.lines.map((l) => ({ account_code: l.code, account_name: l.code, account_type: l.type, account_subtype: l.sub, total_debit: l.debit, total_credit: l.credit }));
    }
    return [];
  }),
}));

import { calculateKpis } from '@/modules/accounting/services/afs/afsKpiService';
import { getIncomeStatement } from '@/modules/accounting/services/reports/incomeStatementService';
import * as kpi from '@/modules/accounting/services/afs/afsKpiService';

const SPELLINGS: Array<string | null> = [null, '', '  ', 'revenue', 'sales', 'default_revenue', 'Other Income', 'other-income', ' OTHER_INCOME ', 'other_income',
  'interest_income', 'disposal_profit_loss', 'unknown_x'];
const EXP: Array<string | null> = [null, '', 'COGS', 'cost-of-sales', 'Cost Of Sales', 'cost_of_sales', 'depreciation', 'Depreciation Expense', 'finance_cost', 'tax_expense', 'unknown_y'];

describe('KPI fold = Income Statement bands', () => {
  it('every spelling', async () => {
    ledger.lines = [
      ...SPELLINGS.map((sub, i) => ({ code: `4${i}`, type: 'revenue' as const, sub, debit: 0, credit: 1000 + i * 37.11 })),
      ...EXP.map((sub, i) => ({ code: `5${i}`, type: 'expense' as const, sub, debit: 100 + i * 13.07, credit: 0 })),
    ];
    const is = await getIncomeStatement('co', '2026-10-01', '2026-10-31');
    const sc = await kpi.getKpiScorecard('co', '2026-10');
    const v = (k: string) => sc.kpis.find((x) => x.key === k)?.value;
    process.stdout.write(`KPIFOLD IS turnover=${is.totalRevenue} other=${is.totalOtherIncome} cos=${is.totalCostOfSales} gm=${is.grossMarginPct} nm=${is.netMarginPct} | KPI gm=${v('grossMarginPct')} nm=${v('netProfitMarginPct')}\n`);
    expect(is.totalOtherIncome).toBeGreaterThan(0);
    expect(is.totalCostOfSales).toBeGreaterThan(0);
    expect(v('grossMarginPct')).toBeCloseTo(is.grossMarginPct!, 9);
    expect(v('netProfitMarginPct')).toBeCloseTo(is.netMarginPct!, 9);
    void calculateKpis;
  });
});
