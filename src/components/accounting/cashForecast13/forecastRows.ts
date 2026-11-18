/**
 * The 13-week grid's rows (pure): the engine's lines grouped for reading, each group with a subtotal per week.
 * Groups, in order: receipts, supplier payments, payroll, SARS, loans, recurring, budget estimate, manual items,
 * overrides, other. A line sits in exactly one: its kind first (an override, a manual item, the budget fill),
 * then a recurring invoice, then its category. Opening and closing cash are the engine's weeks, never re-added.
 */
import type { ForecastLine, ForecastWeek } from '@/modules/accounting/services/cashForecast13/types';

export type GroupId = 'receipts' | 'supplier_payments' | 'payroll' | 'sars' | 'loans' | 'recurring' | 'budget' | 'manual' | 'overrides' | 'other';

export const GROUP_TITLES: Record<GroupId, string> = {
  receipts: 'Receipts from customers',
  supplier_payments: 'Supplier payments',
  payroll: 'Payroll',
  sars: 'SARS',
  loans: 'Loans',
  recurring: 'Recurring invoices',
  budget: 'Budget estimate',
  manual: 'Expected items you added',
  overrides: 'Your changes',
  other: 'Other',
};

const ORDER: readonly GroupId[] = ['receipts', 'supplier_payments', 'payroll', 'sars', 'loans', 'recurring', 'budget', 'manual', 'overrides', 'other'];

const BY_CATEGORY: Record<ForecastLine['category'], GroupId> = {
  customer_receipts: 'receipts', supplier_payments: 'supplier_payments', payroll: 'payroll', sars: 'sars', loans: 'loans', other: 'other',
};

export function groupOf(line: Pick<ForecastLine, 'key' | 'kind' | 'category'>): GroupId {
  if (line.kind === 'override') return 'overrides';
  if (line.kind === 'manual') return 'manual';
  if (line.key.startsWith('budget:')) return 'budget';
  if (line.key.startsWith('recurring:')) return 'recurring';
  return BY_CATEGORY[line.category];
}

export interface LineGroup {
  id: GroupId;
  title: string;
  lines: ForecastLine[];
  subtotal: number[];
  total: number;
}

export function groupLines(lines: readonly ForecastLine[]): LineGroup[] {
  const byId = new Map<GroupId, ForecastLine[]>();
  for (const l of lines) {
    const id = groupOf(l);
    byId.set(id, [...(byId.get(id) ?? []), l]);
  }
  return ORDER.filter((id) => byId.has(id)).map((id) => {
    const ls = byId.get(id) as ForecastLine[];
    const weeks = ls[0]?.weekly.length ?? 0;
    const subtotal = Array.from({ length: weeks }, (_, w) => ls.reduce((s, l) => s + (l.weekly[w] ?? 0), 0));
    return { id, title: GROUP_TITLES[id], lines: ls, subtotal, total: subtotal.reduce((a, b) => a + b, 0) };
  });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-11-16' → '16 Nov', read from the string (no clock, no zone). */
export function shortDay(iso: string): string {
  const [, m, d] = iso.split('-').map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1] ?? ''}`;
}

/** '2026-01-07' → '7 Jan 2026', read from the string (no clock, no zone). */
export function longDay(iso: string): string {
  return `${shortDay(iso)} ${iso.slice(0, 4)}`;
}

/** A group's total row: "Total payroll", but an acronym keeps its capitals ("Total SARS"). */
export function totalRowLabel(title: string): string {
  const words = title.split(' ').map((w) => (w.length > 1 && w === w.toUpperCase() ? w : w.toLowerCase()));
  return `Total ${words.join(' ')}`;
}

export function weekLabel(week: Pick<ForecastWeek, 'index' | 'start'>): string {
  return `Week ${week.index + 1} · ${shortDay(week.start)}`;
}

/** The week with the lowest closing cash (the first, on a tie); undefined for no weeks. */
export function lowestWeek<W extends Pick<ForecastWeek, 'closingCents'>>(weeks: readonly W[]): W | undefined {
  return weeks.reduce<W | undefined>((low, w) => (low === undefined || w.closingCents < low.closingCents ? w : low), undefined);
}
