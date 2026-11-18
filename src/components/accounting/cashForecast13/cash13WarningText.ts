/**
 * The 13-week forecast's warnings (engine + readers, cashForecast13/*.ts) in plain English. Every known code has
 * its own sentence; the code itself is never shown. `detail` carries the server's list (which items, how much)
 * where that list is what the reader needs; an unknown code falls back on the server's message, a sentence too.
 */
import { formatCents } from '@/lib/money/formatMoney';
import type { AssumedPaidItem, ForecastWarning } from '@/modules/accounting/services/cashForecast13/types';
import { longDay } from './forecastRows';

/** `items`: a long list the reader may want, shown collapsed under the detail (never inline). */
export interface WarningWords { title: string; detail?: string; items?: string[] }

const TITLES: Record<string, string> = {
  beyond_horizon: 'Some invoices and payments fall after week 13 and are not in this forecast.',
  budget_flag_off: 'The three-way budget is not switched on, so there are no budget estimates.',
  budget_no_primary: 'No primary budget is set for part of this period, so those months have no budget estimate.',
  budget_unavailable: 'The budget could not be worked out, so there are no budget estimates for it.',
  credit_unused: 'Some unapplied credit is more than the invoices it could settle; the extra is ignored.',
  currency_not_converted: 'Some foreign-currency documents have no exchange rate and are left out.',
  irp6_no_budget: 'A provisional tax payment is due, but no budget gives its amount, so it is not shown.',
  manual_item_past: 'Some one-off items you added are dated before this week, so they are not forecast: change their date or remove them.',
  loan_payments_not_recorded: 'Some loan instalments have no payment recorded; they are assumed paid.',
  payroll_frequency_unsupported: 'Weekly and fortnightly pay runs are not forecast yet; only monthly pay runs are.',
  payroll_no_runs: 'There is no approved monthly pay run, so salaries and the EMP201 are not forecast.',
  payroll_past_assumed_paid: 'Salaries whose pay date has passed are assumed paid (they are in today\'s bank balance).',
  sars_marks_unavailable: 'Could not check which SARS returns are marked filed: a filed return may show as a payment.',
  sars_past_due_assumed_paid: 'SARS payments due before today are assumed paid (they are in today\'s bank balance).',
  sars_submissions_unavailable: 'Could not read the SARS filings: a filed return may show as a payment.',
  vat_no_budget: 'Part of a VAT period has no budget, so its VAT is only what has been accrued so far.',
};

/** Codes whose server message lists what the reader needs (which items, what amount). */
const WITH_DETAIL = new Set([
  'beyond_horizon', 'budget_no_primary', 'budget_unavailable', 'credit_unused', 'currency_not_converted', 'irp6_no_budget',
  'loan_payments_not_recorded', 'manual_item_past', 'payroll_past_assumed_paid', 'sars_past_due_assumed_paid', 'vat_no_budget',
]);

export const KNOWN_WARNING_CODES: ReadonlySet<string> = new Set([...Object.keys(TITLES), 'source_unavailable', 'override_skipped']);

const sentence = (s: string): string => (/[.!?]$/.test(s) ? s : `${s}.`);

const sumCents = (xs: readonly AssumedPaidItem[]): number => xs.reduce((s, x) => s + Math.abs(x.cents), 0);

/**
 * The SARS returns assumed paid, in one line: "16 returns due 7 Jan 2026 to 6 Nov 2026, R 1 000.00 in total, are
 * not marked filed." (the title already says they are assumed paid). Payments and refunds are never netted.
 * Whole cents (integers), formatted by formatCents.
 */
function assumedPaidWords(title: string, list: readonly AssumedPaidItem[]): WarningWords {
  const dues = list.map((a) => a.dueDate).sort();
  const first = dues[0] as string;
  const last = dues[dues.length - 1] as string;
  const payments = list.filter((a) => a.cents <= 0);
  const refunds = list.filter((a) => a.cents > 0);
  const money = [
    payments.length > 0 ? `${formatCents(sumCents(payments))} ${refunds.length > 0 ? 'in payments' : 'in total'}` : '',
    refunds.length > 0 ? `${formatCents(sumCents(refunds))} in refunds` : '',
  ].filter(Boolean).join(' and ');
  const many = list.length > 1;
  const range = many && first !== last ? `${longDay(first)} to ${longDay(last)}` : longDay(first);
  const detail = many
    ? `${list.length} returns due ${range}, ${money}, are not marked filed.`
    : `1 return due ${range}, ${formatCents(Math.abs((list[0] as AssumedPaidItem).cents))}${refunds.length > 0 ? ' refund' : ''}, is not marked filed.`;
  const lines = list.length > 1
    ? list.map((a) => `${a.kind} ${longDay(a.periodStart)} to ${longDay(a.periodEnd)}, due ${longDay(a.dueDate)}: ${formatCents(Math.abs(a.cents))}${a.cents > 0 ? ' refund' : ''}`)
    : undefined;
  return lines ? { title, detail, items: lines } : { title, detail };
}

export function cash13WarningText(w: ForecastWarning): WarningWords {
  if (w.code === 'source_unavailable') {
    const why = /could not be read: (.*?); the forecast leaves it out$/.exec(w.message)?.[1];
    const title = `Could not read the ${w.source}: they are left out of this forecast.`;
    return why ? { title, detail: sentence(why) } : { title };
  }
  if (w.code === 'override_skipped') {
    const m = /week (\d+) skipped: (.*)$/.exec(w.message);
    return { title: m ? `One of your changes (week ${m[1]}) was not applied: ${sentence(m[2] as string)}` : 'One of your changes was not applied.' };
  }
  const title = TITLES[w.code];
  if (!title) return { title: sentence(w.message) };
  if (w.code === 'sars_past_due_assumed_paid' && w.assumedPaid && w.assumedPaid.length > 0) return assumedPaidWords(title, w.assumedPaid);
  return WITH_DETAIL.has(w.code) && w.message ? { title, detail: sentence(w.message) } : { title };
}
