/**
 * Budget fill (ruling 2026-11-16): for each month the 13 weeks touch, per category (customer receipts,
 * supplier payments), the three-way budget's direct cash flow MINUS what known items already put in that
 * month, floored at zero, spread evenly over the month's days; only the days from today to the last Sunday
 * are counted (earlier days are history, already in opening cash). Lines are estimates. Pure.
 *
 * A known item counts in the month of its EFFECTIVE date (an overdue invoice expected today counts in
 * today's month). Days are allocated by cumulative rounding — day d of a D-day month gets
 * round(R·d/D) − round(R·(d−1)/D) — so a full month sums to exactly R in integer cents.
 */
import type { BudgetMonth, CashCategory, ForecastLine, KnownItem } from './types';
import { assertCents, effectiveDate, emptyWeekly } from './lines';
import { daysInMonth, weekIndexOf, type WeekSpan } from './weeks';

const FILLED: ReadonlyArray<{ category: CashCategory; field: 'customerReceipts' | 'supplierPayments'; dir: 1 | -1; label: string }> = [
  { category: 'customer_receipts', field: 'customerReceipts', dir: 1, label: 'Budgeted receipts from customers (not yet invoiced)' },
  { category: 'supplier_payments', field: 'supplierPayments', dir: -1, label: 'Budgeted payments to suppliers (not yet billed)' },
];

function knownByMonth(items: readonly KnownItem[], category: CashCategory, today: string, weeks: readonly WeekSpan[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const it of items) {
    if (it.category !== category || weekIndexOf(it.date, today, weeks) === null) continue;
    const month = effectiveDate(it.date, today).slice(0, 7);
    out.set(month, (out.get(month) ?? 0) + it.amountCents);
  }
  return out;
}

export function budgetFillLines(
  budget: readonly BudgetMonth[], known: readonly KnownItem[], today: string, weeks: readonly WeekSpan[],
): ForecastLine[] {
  const horizonEnd = (weeks[weeks.length - 1] as WeekSpan).end;
  const lines: ForecastLine[] = [];
  for (const f of FILLED) {
    const knownIn = knownByMonth(known, f.category, today, weeks);
    const weekly = emptyWeekly();
    const items: ForecastLine['items'] = [];
    for (const bm of budget) {
      const amount = bm[f.field];
      assertCents(amount, `budget ${bm.month} ${f.field}`);
      const remaining = Math.max(0, amount * f.dir - (knownIn.get(bm.month) ?? 0) * f.dir);
      if (remaining === 0) continue;
      const days = daysInMonth(bm.month);
      let counted = 0;
      let firstWeek = -1;
      for (let d = 1; d <= days; d++) {
        const date = `${bm.month}-${String(d).padStart(2, '0')}`;
        if (date < today || date > horizonEnd) continue;
        const share = Math.round((remaining * d) / days) - Math.round((remaining * (d - 1)) / days);
        const w = weekIndexOf(date, today, weeks) as number;
        weekly[w] = (weekly[w] as number) + share * f.dir;
        counted += share;
        if (firstWeek < 0) firstWeek = w;
      }
      if (counted !== 0) {
        items.push({ ref: `budget:${bm.month}`, label: `Budget ${bm.month} less known`, date: `${bm.month}-01`, weekIndex: firstWeek, amountCents: counted * f.dir });
      }
    }
    const totalCents = weekly.reduce((a, b) => a + b, 0);
    if (items.length === 0) continue;
    lines.push({ key: `budget:${f.category}`, label: f.label, category: f.category, kind: 'estimate', weekly, totalCents, flags: ['budget_estimate'], items });
  }
  return lines;
}
