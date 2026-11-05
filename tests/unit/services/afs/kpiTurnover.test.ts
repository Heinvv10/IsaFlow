/**
 * The KPI scorecard's revenue is turnover, banded by the SAME fold the Income Statement report uses
 * (`aggregateFigures`, canonical subtypes): other income sits below gross profit, "Other Income" / "COGS"
 * spellings band as the report bands them, and a NULL-subtype revenue account is turnover.
 */
import { describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: m.sql }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/afs/afsKpiCash', () => ({ fetchOpeningCash: vi.fn(async () => 0), fetchClosingCash: vi.fn(async () => 0) }));

import { getKpiScorecard } from '@/modules/accounting/services/afs/afsKpiService';

type G = { account_type: string; account_subtype: string | null; debit: number; credit: number };
async function gross(groups: G[]): Promise<{ value: number; net: number }> {
  m.sql.mockImplementation(async (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    return text.includes('GROUP BY ga.account_type, ga.account_subtype') ? groups : [{}];
  });
  const { kpis } = await getKpiScorecard('co', '2026-09');
  return {
    value: kpis.find((k) => k.key === 'grossMarginPct')?.value ?? NaN,
    net: kpis.find((k) => k.key === 'netProfitMarginPct')?.value ?? NaN,
  };
}

describe('KPI revenue is turnover', () => {
  it('other income is below gross profit, whatever its spelling', async () => {
    for (const spelling of ['other_income', 'Other Income', 'OTHER-INCOME', 'other_revenue']) {
      const r = await gross([
        { account_type: 'revenue', account_subtype: null, debit: 0, credit: 1000 },
        { account_type: 'revenue', account_subtype: spelling, debit: 0, credit: 200 },
        { account_type: 'expense', account_subtype: 'Cost Of Sales', debit: 400, credit: 0 },
      ]);
      // (1000 - 400) / 1000: the 200 of other income is neither in the denominator nor in gross profit.
      expect(r.value).toBeCloseTo(60, 6);
      // Net profit still includes it: (1000 + 200 - 400) / 1000.
      expect(r.net).toBeCloseTo(80, 6);
    }
  });

  it('a revenue account with no subtype is turnover', async () => {
    const r = await gross([{ account_type: 'revenue', account_subtype: null, debit: 0, credit: 500 }, { account_type: 'expense', account_subtype: 'cogs', debit: 100, credit: 0 }]);
    expect(r.value).toBeCloseTo(80, 6);
  });
});
