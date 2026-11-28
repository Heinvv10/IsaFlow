/**
 * W29's explanation step (wave 7 PRA; review #1901 M6): a recurring earning paid its share of the period shows the share
 * as part of the formula, "12 of 23 working days of R2 100.00, to the cent", with the full amount and the share as parts.
 * Pure: the figures are the accumulator's (EarningPart.share, set by apportionRecurringRows), never recomputed here.
 */
import { formatMoney } from '@/lib/money/formatMoney';
import { describeShare } from './payrollRecurringShare';
import type { ExplainSource, ExplainStep } from './payrollExplainTypes';
import type { RecurringShare } from './payrollTypes';

const SHARE_SOURCE: ExplainSource = {
  label: 'Apportioned by the days it ran inside employment (monthly: working days; weekly or fortnightly: calendar days); '
    + 'basis: IsaFlow payroll ruling (wave 7, W29). SARS sets no basis for apportioning pay.',
};

/** The step for an earning apportioned by its dates; `included` is what the totals took of it. */
export function recurringShareStep(key: string, label: string, included: number, share: RecurringShare): ExplainStep {
  return {
    key, label, amount: included, source: SHARE_SOURCE,
    formula: `${share.days} of ${share.of} ${share.basis === 'working_days' ? 'working' : 'calendar'} days of ${formatMoney(share.fullAmount)}, to the cent`,
    note: `Started or ended inside employment this period: paid ${describeShare(share)}.`,
    children: [
      { key: `${key}.full`, label: 'The amount for a whole period', amount: share.fullAmount },
      { key: `${key}.share`, label: 'The share of the period it ran', amount: share.share, unit: 'percent' },
    ],
  };
}
