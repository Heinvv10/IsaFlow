/**
 * Folding dated items into forecast lines: one line per `lineKey`, each item in the week its date falls in
 * (weeks.ts: the past lands in week 1, past the horizon is left out). Pure.
 */
import { FORECAST_WEEKS, type CashCategory, type KnownItem, type ForecastLine, type LineKind, type ArBasis } from './types';
import { weekIndexOf, type WeekSpan } from './weeks';

export const CATEGORY_ORDER: readonly CashCategory[] = ['customer_receipts', 'supplier_payments', 'payroll', 'sars', 'loans', 'other'];

export function emptyWeekly(): number[] {
  return Array.from({ length: FORECAST_WEEKS }, () => 0);
}

export function assertCents(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) throw new Error(`cash13: ${what} must be integer cents, got ${String(value)}`);
}

/** The effective date of an item: today for anything earlier (it is expected in week 1, from today). */
export function effectiveDate(date: string, today: string): string {
  return date < today ? today : date;
}

interface Folded { lines: ForecastLine[]; beyondHorizon: number }

/** Items → lines. `kind` is the line's unless an item is an estimate (then the line is). */
export function foldItems(items: readonly KnownItem[], kind: LineKind, today: string, weeks: readonly WeekSpan[]): Folded {
  const byKey = new Map<string, ForecastLine>();
  let beyondHorizon = 0;
  for (const it of items) {
    assertCents(it.amountCents, `item ${it.ref}`);
    const w = weekIndexOf(it.date, today, weeks);
    if (w === null) {
      beyondHorizon += 1;
      continue;
    }
    let line = byKey.get(it.lineKey);
    if (!line) {
      line = { key: it.lineKey, label: it.lineLabel, category: it.category, kind, weekly: emptyWeekly(), totalCents: 0, flags: [], items: [] };
      byKey.set(it.lineKey, line);
    }
    if (it.basis) {
      line.basisCents ??= { due: 0, history: 0, no_history: 0 };
      line.basisCents[it.basis] += it.amountCents;
    }
    line.weekly[w] = (line.weekly[w] as number) + it.amountCents;
    line.totalCents += it.amountCents;
    if (it.estimate && line.kind === 'known') line.kind = 'estimate';
    for (const f of it.flags ?? []) if (!line.flags.includes(f)) line.flags.push(f);
    const li: ForecastLine['items'][number] = { ref: it.ref, label: it.refLabel, date: it.date, weekIndex: w, amountCents: it.amountCents };
    if (it.basis) li.basis = it.basis as ArBasis;
    line.items.push(li);
  }
  return { lines: [...byKey.values()], beyondHorizon };
}

/** A stable order for lines and their items, so the output never depends on the order readers returned rows. */
export function sortLines(lines: ForecastLine[]): ForecastLine[] {
  const kindRank: Record<LineKind, number> = { known: 0, estimate: 1, manual: 2, override: 3 };
  for (const l of lines) {
    l.items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : a.amountCents - b.amountCents));
    l.flags.sort();
  }
  return lines.sort((a, b) =>
    CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category)
    || kindRank[a.kind] - kindRank[b.kind]
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Rand (a number, or a NUMERIC string from pg) → integer cents. The toFixed step absorbs binary noise (10.005 × 100). */
export function toCents(rand: number | string): number {
  const n = typeof rand === 'string' ? Number(rand) : rand;
  if (!Number.isFinite(n)) throw new Error(`cash13: not an amount: ${String(rand)}`);
  return Math.round(Number((n * 100).toFixed(4)));
}
