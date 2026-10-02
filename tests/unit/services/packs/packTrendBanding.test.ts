/**
 * THE TREND SERIES AND THE STATEMENTS MUST BAND THE SAME LEDGER THE SAME WAY.
 *
 * They did not. `getPackTrend` summed every `account_type = 'revenue'` account
 * into one figure it called `revenue`, while `aggregateFigures` bands other
 * income out of revenue — so the board pack printed Brightsphere's revenue as
 * (5 536) on the trends and group-results sheets against (5 535) on the income
 * statement, the other-income account to the rand, and its NET PROFIT agreed
 * exactly. Net-profit-agrees-and-gross-does-not is the signature of finding
 * B75, which is the same defect between the income statement page and the MCP
 * `profit_and_loss` tool; that one was fixed by banding both sides through the
 * exported `revenueBand`/`expenseBand` and pinned by
 * `incomeStatementConvergence.test.ts`. This service never got the fix, and
 * nothing here would have caught it: eight blind visual gates read a page-10
 * note attributing the whole disagreement to the reporting window, which was a
 * true cause stated as the only cause.
 *
 * This is that missing guard. It is deliberately an EQUIVALENCE over the whole
 * alias domain rather than a spot check on the subtypes that happen to appear
 * in the dev database: a band is wrong exactly when its membership and the
 * classifier's answer disagree on any spelling, and `ALL_RAW_SUBTYPES` is the
 * classifier's own list rather than a copy of it, so a subtype added later is
 * covered without anyone remembering to add it here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ALL_RAW_SUBTYPES,
  canonicalSubtype,
} from '@/modules/accounting/services/gl/accountSubtypes';
import { expenseBand, revenueBand } from '@/modules/accounting/services/gl/accountClassification';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  BELOW_OPERATING_LINE_SUBTYPES,
  COST_OF_SALES_SUBTYPES,
  OTHER_INCOME_SUBTYPES,
  getPackTrend,
} from '@/modules/accounting/services/packs/packTrendService';

const COMPANY = '11111111-1111-4111-8111-111111111111';

/**
 * Spellings the alias table deliberately does NOT know — `other` and
 * `disposal_profit_loss` resolve to null and are reported as unclassified —
 * plus the empty and absent cases a column really carries.
 */
const UNALIASED = ['other', 'disposal_profit_loss', 'not_a_subtype', ''];

describe('the pack trend bands exactly as the classifier does', () => {
  it('puts a subtype in the other-income bucket if and only if revenueBand does', () => {
    expect(ALL_RAW_SUBTYPES.length).toBeGreaterThan(20);
    for (const raw of [...ALL_RAW_SUBTYPES, ...UNALIASED]) {
      expect(
        OTHER_INCOME_SUBTYPES.includes(raw),
        `${raw}: bucket says ${OTHER_INCOME_SUBTYPES.includes(raw)}, revenueBand says ${revenueBand(raw)}`,
      ).toBe(revenueBand(raw) === 'other_income');
    }
  });

  it('puts a subtype in the cost-of-sales and below-the-line buckets if and only if expenseBand does', () => {
    for (const raw of [...ALL_RAW_SUBTYPES, ...UNALIASED]) {
      expect(COST_OF_SALES_SUBTYPES.includes(raw), raw).toBe(expenseBand(raw) === 'cost_of_sales');
      expect(BELOW_OPERATING_LINE_SUBTYPES.includes(raw), raw).toBe(expenseBand(raw) === 'other_expense');
    }
  });

  /**
   * A NULL SUBTYPE IS THE DEFAULT ON BOTH SIDES, and it is the case a SQL
   * `= ANY(...)` predicate and a JavaScript lookup could most easily disagree
   * about: `= ANY` is false for NULL, `canonicalSubtype(null)` is null, and
   * both bands default. The same answer, arrived at the same way.
   */
  it('leaves a NULL subtype in turnover and in operating expenses, as the classifier does', () => {
    expect(canonicalSubtype(null)).toBeNull();
    expect(revenueBand(null)).toBe('turnover');
    expect(expenseBand(null)).toBe('operating_expense');
    for (const bucket of [OTHER_INCOME_SUBTYPES, COST_OF_SALES_SUBTYPES, BELOW_OPERATING_LINE_SUBTYPES]) {
      expect(bucket.some((s) => s === null || s === undefined)).toBe(false);
    }
  });

  /**
   * The arrays above are only a guard if the QUERY uses them. Captured off the
   * tagged template's interpolated values, so deleting the other-income bucket
   * from the SELECT list fails here even with the constant left behind.
   */
  it('passes the other-income band into the query it actually issues', async () => {
    sqlMock.mockResolvedValue([]);
    await getPackTrend(COMPANY, '2026-03-31', 2);
    const params = sqlMock.mock.calls[0]!.slice(1);
    const arrays = params.filter((p): p is string[] => Array.isArray(p));
    expect(arrays).toContainEqual(OTHER_INCOME_SUBTYPES);
    expect(arrays).toContainEqual(COST_OF_SALES_SUBTYPES);
    expect(arrays).toContainEqual(BELOW_OPERATING_LINE_SUBTYPES);
  });
});

describe('splitting other income out of revenue is a reclassification, not a restatement', () => {
  beforeEach(() => sqlMock.mockReset());

  it('reports turnover as revenue, other income beside it, and the same net profit as before', async () => {
    // The old unbanded query returned one `revenue` of 5 053 787.07. The two
    // bands must sum back to it, and the bottom line must not move — the same
    // invariant `incomeStatementConvergence.test.ts` holds on the statement.
    sqlMock.mockResolvedValue([{
      month: '2026-03',
      revenue_and_other_income: '5053787.07',
      other_income: '53787.07',
      expenses: '2410000',
      cost_of_sales: '1800000',
      below_operating_line: '210000',
    }]);
    const points = await getPackTrend(COMPANY, '2026-03-31', 1);
    const march = points[0]!;

    expect(march.revenue).toBeCloseTo(5_000_000, 2);
    expect(march.otherIncome).toBeCloseTo(53_787.07, 2);
    expect(march.revenue + march.otherIncome).toBeCloseTo(5_053_787.07, 2);
    expect(march.netProfit).toBeCloseTo(5_053_787.07 - 2_410_000, 2);
  });

  it('takes gross margin on TURNOVER, the base the income statement uses', async () => {
    sqlMock.mockResolvedValue([{
      month: '2026-03',
      revenue_and_other_income: '5053787.07',
      other_income: '53787.07',
      expenses: '1800000',
      cost_of_sales: '1800000',
    }]);
    const march = (await getPackTrend(COMPANY, '2026-03-31', 1))[0]!;
    // (5 000 000 − 1 800 000) / 5 000 000 = 64.00%. On the unbanded base it is
    // 64.31%, which is the number page 10 printed against page 6's 64.00%.
    expect(march.grossMarginPct).toBeCloseTo(64, 2);
    expect(march.grossMarginPct).not.toBeCloseTo(
      ((5_053_787.07 - 1_800_000) / 5_053_787.07) * 100, 2,
    );
  });

  it('measures debtor days against turnover too', async () => {
    sqlMock.mockResolvedValue([{
      month: '2026-03',
      revenue_and_other_income: '5053787.07',
      other_income: '53787.07',
      expenses: '0',
      receivable_movement: '1000000',
    }]);
    const march = (await getPackTrend(COMPANY, '2026-03-31', 1))[0]!;
    // 1 000 000 / 5 000 000 × 31 days.
    expect(march.debtorDays).toBeCloseTo((1_000_000 / 5_000_000) * 31, 2);
  });

  it('carries no other income where the ledger has none, and leaves revenue whole', async () => {
    sqlMock.mockResolvedValue([{ month: '2026-03', revenue_and_other_income: '900000', expenses: '100000' }]);
    const march = (await getPackTrend(COMPANY, '2026-03-31', 1))[0]!;
    expect(march.otherIncome).toBe(0);
    expect(march.revenue).toBe(900_000);
    expect(march.netProfit).toBe(800_000);
  });
});
