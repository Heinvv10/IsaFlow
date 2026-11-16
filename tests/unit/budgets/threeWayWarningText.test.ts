/**
 * `opening_excess_spread` in words (spec §13.26): the days are at the 365-day limit
 * and the opening excess is collected (paid) evenly over the version's months.
 */
import { describe, expect, it } from 'vitest';
import { warningText } from '@/components/accounting/budgets/threeWay/warningText';
import { formatStatementFigure } from '@/lib/format/money';

const R = (cents: number) => formatStatementFigure(cents / 100, { symbol: true, cents: true });

describe('warningText opening_excess_spread', () => {
  it('debtors: at the limit, the amount, collected evenly over the months', () => {
    expect(warningText({ code: 'opening_excess_spread', series: 'receivables', days: 365, excess: 48_000_000, months: 12 }))
      .toBe(`Debtor days are at the 365-day limit, so the ${R(48_000_000)} of opening debtors above that level is collected evenly over the 12 months.`);
  });
  it('creditors with an excess: paid evenly', () => {
    expect(warningText({ code: 'opening_excess_spread', series: 'payables', days: 365, excess: 24_000_000, months: 12 }))
      .toBe(`Creditor days are at the 365-day limit, so the ${R(24_000_000)} of opening creditors above that level is paid evenly over the 12 months.`);
  });
});
