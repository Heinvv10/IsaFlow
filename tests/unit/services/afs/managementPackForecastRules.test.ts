/**
 * The cash flow forecast section's edge rules (blind review of 7e70f9e62e): which three-way errors are refusals
 * (a sentence) and which are faults (the pack is held), the minimum-cash and lowest-month boundaries, and the
 * warnings scoped to the shown months, with months in words and money in the pack's format.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  hasFeature: vi.fn(),
  getThreeWay: vi.fn(),
  withSavepoint: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: m.withSavepoint }));
vi.mock('@/lib/logger', () => ({ log: m.log }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/modules/admin/services/featureFlagService', () => ({ hasFeature: m.hasFeature }));
vi.mock('@/modules/accounting/services/budgets/threeWay/threeWayViews', () => ({ getThreeWay: m.getThreeWay }));
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry', () => ({ fiscalYearForDate: vi.fn(async () => ({ fiscalYear: 2027 })) }));

import { forecastBlocks, forecastSnapshot, loadPackForecast } from '@/modules/accounting/services/afs/managementPackForecast';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import {
  AssumptionChainError, AssumptionsDocError, CompareInputError, EngineInputError, OpeningUnbalancedError,
} from '@/modules/accounting/services/budgets/threeWay/errors';
import { threeWayInputError } from '@/modules/accounting/services/budgets/threeWay/serviceErrors';
import { formatCents } from '@/lib/money/formatMoney';
import type { NoteContentTable } from '@/modules/accounting/services/afs/afsTypes';
import type { ThreeWayView } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';
import { threeWayView } from './managementPackForecastFixtures';

const plain = (s: string): string => s.replace(/ /g, ' ');
const load = (period = '2026-10') => loadPackForecast('co', period, `${period}-28`, '2026-11-16');
const textOf = async (view: ThreeWayView, period?: string) => {
  m.getThreeWay.mockResolvedValue(view);
  return plain(JSON.stringify(forecastBlocks(await load(period))));
};
const cash = (closing: number[]) => {
  const months = ['2026-10', '2026-11', '2026-12'];
  return { months, cashFlow: { direct: months.map((month, i) => ({ month, closingCash: closing[i] as number })), indirect: [] } } as Partial<ThreeWayView>;
};

beforeEach(() => {
  vi.clearAllMocks();
  m.hasFeature.mockResolvedValue(true);
  m.getThreeWay.mockResolvedValue(threeWayView());
});

describe('refusal or fault', () => {
  it.each([
    ['BudgetVersionError (locked)', new BudgetVersionError('BUDGET_VERSION_LOCKED', 'locked')],
    ['ThreeWayServiceError', threeWayInputError('bad')],
    ['AssumptionChainError', new AssumptionChainError('CYCLE', 'cycle', ['a'])],
    ['AssumptionsDocError', new AssumptionsDocError([{ path: 'x', message: 'bad' }])],
    ['OpeningUnbalancedError', new OpeningUnbalancedError(5)],
    ['EngineInputError RANGE', new EngineInputError('RANGE', 'too big')],
    ['EngineInputError LOAN_SCHEDULE', new EngineInputError('LOAN_SCHEDULE', 'loan')],
  ])('%s is a refusal: a sentence, the pack is not held', async (_name, err) => {
    m.getThreeWay.mockRejectedValue(err);
    expect(await load()).toEqual({ kind: 'unavailable', fault: false });
    expect(m.log.error).not.toHaveBeenCalled();
  });

  it.each([
    ['EngineInputError PNL', new EngineInputError('PNL', 'x')],
    ['EngineInputError MONTHS', new EngineInputError('MONTHS', 'x')],
    ['EngineInputError LOOKBACK', new EngineInputError('LOOKBACK', 'x')],
    ['EngineInputError CHECKS', new EngineInputError('CHECKS', 'x')],
    ['CompareInputError', new CompareInputError('COUNT', 'x')],
  ])('%s is a fault (a caller bug): logged as an error, the pack is held', async (_name, err) => {
    m.getThreeWay.mockRejectedValue(err);
    expect(await load()).toEqual({ kind: 'unavailable', fault: true });
    expect(m.log.error).toHaveBeenCalled();
  });

  it('a failed flag read is a fault, never swallowed as "off"', async () => {
    m.hasFeature.mockRejectedValue(new Error('relation does not exist'));
    expect(await load()).toEqual({ kind: 'unavailable', fault: true });
    expect(m.getThreeWay).not.toHaveBeenCalled();
  });

  it('the unavailable snapshot keeps whether it was a fault', () => {
    expect(forecastSnapshot({ kind: 'unavailable', fault: true })).toEqual({ kind: 'unavailable', fault: true });
    expect(forecastSnapshot({ kind: 'unavailable', fault: false })).toEqual({ kind: 'unavailable', fault: false });
  });
});

describe('boundaries', () => {
  it('a month exactly at the minimum is not below it, and the lowest sentence then has no "below" clause', async () => {
    m.getThreeWay.mockResolvedValue(threeWayView({ ...cash([700_000, 500_000, 600_000]), warnings: [] }));
    const blocks = forecastBlocks(await load());
    const table = blocks.find((b) => b.type === 'table') as NoteContentTable;
    expect(table.rows.map((r) => r[3])).toEqual(['No', 'No', 'No']);
    const text = plain(JSON.stringify(blocks));
    expect(text).toContain('The lowest month-end cash is R 5 000.00 in November 2026.');
    expect(text).not.toContain('below the minimum');
  });

  it('on a tie the lowest month is the first of them', async () => {
    m.getThreeWay.mockResolvedValue(threeWayView({ ...cash([700_000, 300_000, 300_000]), warnings: [] }));
    const f = await load();
    expect(f.kind === 'forecast' && f.figures.lowest).toEqual({ month: '2026-11', closingCash: 300_000 });
  });

  it('a provisional opening says so in the intro, and its warning is not repeated', async () => {
    const view = threeWayView({ opening: { asAt: '2026-11-16', provisional: true }, warnings: [{ code: 'opening_provisional', asAt: '2026-11-16' }] } as Partial<ThreeWayView>);
    const text = await textOf(view);
    expect(text).toContain('on opening balances as at 16 November 2026 (provisional).');
    expect(text).not.toContain('today');
    expect(text).not.toContain('"type":"list"');
  });

  it('no months from the pack month on: one sentence, no table', async () => {
    const blocks = (m.getThreeWay.mockResolvedValue(threeWayView()), forecastBlocks(await load('2027-03')));
    expect(blocks.some((b) => b.type === 'table')).toBe(false);
    expect(plain(JSON.stringify(blocks))).toContain('The Original 2027 budget has no months from March 2027 to the year end.');
  });
});

describe('warnings and checks within the shown months', () => {
  it('negative cash and negative flows before the pack month are dropped; months print in words', async () => {
    const view = threeWayView({
      warnings: [
        { code: 'negative_cash', months: ['2026-05', '2026-11'] },
        { code: 'negative_flow', month: '2026-04', flow: 'receipts', amount: -100 },
        { code: 'negative_flow', month: '2026-12', flow: 'receipts', amount: -12_345 },
      ],
    } as Partial<ThreeWayView>);
    const text = await textOf(view);
    expect(text).toContain('Cash below zero in November 2026.');
    expect(text).not.toContain('May 2026');
    expect(text).not.toContain('April 2026');
    expect(text).toContain(`Receipts came out negative in December 2026 (${plain(formatCents(-12_345))})`);
    expect(text).not.toMatch(/\b\d{4}-\d{2}\b/);
  });

  it('a negative cash warning wholly before the pack month is dropped', async () => {
    const text = await textOf(threeWayView({ warnings: [{ code: 'negative_cash', months: ['2026-05'] }] } as Partial<ThreeWayView>));
    expect(text).not.toContain('Cash below zero');
  });

  it('warning amounts use the pack format', async () => {
    const view = threeWayView({ warnings: [{ code: 'opening_cash_difference', differenceCents: -1_234, accounts: ['1110'] }] } as Partial<ThreeWayView>);
    expect(await textOf(view)).toContain(`differs from the cash book by ${plain(formatCents(-1_234))}`);
  });

  it('the balance check covers the whole year: months before the pack month are reported too, in words', async () => {
    const checks = { balanced: false, unbalancedMonths: ['2026-04', '2026-05'], openingCash: { difference: 0, accounts: [] } };
    expect(await textOf(threeWayView({ checks } as Partial<ThreeWayView>))).toContain('The budget does not balance in April 2026 and May 2026.');
    const three = { balanced: false, unbalancedMonths: ['2026-04', '2026-05', '2026-11'], openingCash: { difference: 0, accounts: [] } };
    expect(await textOf(threeWayView({ checks: three } as Partial<ThreeWayView>))).toContain('does not balance in April 2026, May 2026 and November 2026.');
  });
});

describe('only month fields become words; other text passes through', () => {
  it('NNNN-NN account codes are untouched', async () => {
    const view = threeWayView({ warnings: [
      { code: 'opening_cash_difference', differenceCents: -100, accounts: ['8400-10', '1000-15'] },
      { code: 'unmapped_balance', accounts: [{ accountCode: '2100-03' }] },
    ] } as Partial<ThreeWayView>);
    const text = await textOf(view);
    expect(text).toContain('(accounts 8400-10, 1000-15)');
    expect(text).toContain('lines: 2100-03.');
    expect(text).not.toContain('October 8400');
    expect(text).not.toContain('March 2100');
  });

  it('lookback months are in words', async () => {
    const view = threeWayView({ warnings: [{ code: 'lookback_short', series: 'receivables', months: ['2025-12', '2026-01'] }] } as Partial<ThreeWayView>);
    expect(await textOf(view)).toContain('(December 2025, January 2026)');
  });

  it('outside-months entries name the entry, keep its id as entered, and print no raw month', async () => {
    const view = threeWayView({ warnings: [{ code: 'outside_months', entries: [
      { list: 'capex', id: 'cap-2100-03', skipped: 'entry', detail: 'capex cap-2100-03 dated 2027-05, outside 2026-03..2027-02: skipped' },
      { list: 'equity.dividends', id: 'd1', skipped: 'payment', detail: 'dividend d1 paid 2027-04, after 2027-02: payment skipped, the declaration stays payable' },
    ] }] } as Partial<ThreeWayView>);
    const text = await textOf(view);
    expect(text).toContain('capex cap-2100-03; dividend d1 (its payment)');
    expect(text).not.toMatch(/20\d{2}-\d{2}(?!-03)/);
  });
});
