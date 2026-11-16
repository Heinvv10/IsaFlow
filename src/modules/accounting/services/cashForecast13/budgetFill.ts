/**
 * Budget fill (ruling 2026-11-16, revised after review M1): for each month the 13 weeks touch, per category
 * (customer receipts, supplier payments), the part of the three-way budget that falls inside the forecast —
 * the budget × (the month's days from today to the last Sunday ÷ the month's days) — MINUS the known items
 * dated in that same in-horizon part, floored at zero, spread evenly over those in-horizon days. Prorating
 * first matters: subtracting a month's known items from its WHOLE budget and then keeping half left phantom
 * receipts in a half-month (review probe: R1m budget, R500k known, 15 of 30 days → R250k invented). Pure.
 *
 * A known item counts by its EFFECTIVE date (an overdue invoice expected today counts in today's month); every
 * effective date is inside the horizon. Days are allocated by cumulative rounding over the in-horizon days, so
 * they sum to exactly the remainder in integer cents.
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
      const monthDays = daysInMonth(bm.month);
      const days: string[] = [];
      for (let d = 1; d <= monthDays; d++) {
        const date = `${bm.month}-${String(d).padStart(2, '0')}`;
        if (date >= today && date <= horizonEnd) days.push(date);
      }
      if (days.length === 0) continue;
      const inHorizon = Math.round((amount * f.dir * days.length) / monthDays);
      const remaining = Math.max(0, inHorizon - (knownIn.get(bm.month) ?? 0) * f.dir);
      if (remaining === 0) continue;
      let counted = 0;
      let firstWeek = -1;
      days.forEach((date, i) => {
        const share = Math.round((remaining * (i + 1)) / days.length) - Math.round((remaining * i) / days.length);
        const w = weekIndexOf(date, today, weeks) as number;
        weekly[w] = (weekly[w] as number) + share * f.dir;
        counted += share;
        if (firstWeek < 0) firstWeek = w;
      });
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
