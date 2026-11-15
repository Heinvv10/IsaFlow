/**
 * `days_capped` in words (spec §13.26): the header says the days are capped and, when the opening sits above the
 * days level, that the excess is collected (paid) evenly over the version's months.
 */
import { describe, expect, it } from 'vitest';
import { warningText } from '@/components/accounting/budgets/threeWay/warningText';
import { formatStatementFigure } from '@/lib/format/money';

const R = (cents: number) => formatStatementFigure(cents / 100, { symbol: true, cents: true });

describe('warningText days_capped', () => {
  it('debtors with an excess: capped, the amount, collected evenly over the months', () => {
    expect(warningText({ code: 'days_capped', series: 'receivables', days: 365, excess: 48_000_000, months: 12 }))
      .toBe(`Debtor days are capped at 365: the ${R(48_000_000)} of opening debtors above that level is collected evenly over the 12 months.`);
  });
  it('creditors with an excess: paid evenly', () => {
    expect(warningText({ code: 'days_capped', series: 'payables', days: 365, excess: 24_000_000, months: 12 }))
      .toBe(`Creditor days are capped at 365: the ${R(24_000_000)} of opening creditors above that level is paid evenly over the 12 months.`);
  });
  it('no excess: only the cap', () => {
    expect(warningText({ code: 'days_capped', series: 'receivables', days: 365, excess: 0, months: 12 }))
      .toBe('Debtor days are capped at 365.');
  });
});
