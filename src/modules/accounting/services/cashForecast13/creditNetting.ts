/**
 * Unapplied credit netted off expected receipts and payments (review M2). Pure.
 *
 * A customer with R40k of unapplied receipts or credit notes pays R40k less than its open invoices say; a
 * supplier holding our payment on account or a credit note is owed that much less. The credit per entity comes
 * from `getUnappliedByEntity` (shared/agedNetting.ts, the aged reports' own netting). It comes off that
 * entity's items EARLIEST FIRST (by expected date, then document), never taking an item below zero; an item
 * netted to zero is dropped. Credit left after every item of the entity (more credit than open documents) is
 * not cash to come and is ignored — the caller warns with the total.
 */
import type { KnownItem } from './types';

export interface NetResult {
  items: KnownItem[];
  /** Credit with nothing left to net against, per entity name (cents, positive). */
  unused: Array<{ entityId: string; cents: number }>;
}

/** `credit`: per entity, the unapplied credit in cents (positive = in the company's favour on AR, ours on AP). */
export function netCredits(items: readonly KnownItem[], credit: ReadonlyMap<string, number>): NetResult {
  const left = new Map([...credit].filter(([, c]) => c > 0));
  const order = items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => (a.it.date < b.it.date ? -1 : a.it.date > b.it.date ? 1 : a.it.ref < b.it.ref ? -1 : a.it.ref > b.it.ref ? 1 : a.i - b.i));
  const netted = new Map<number, number>();
  for (const { it, i } of order) {
    const avail = it.entityId === undefined ? 0 : left.get(it.entityId) ?? 0;
    const size = Math.abs(it.amountCents);
    const used = Math.min(avail, size);
    if (used > 0) left.set(it.entityId as string, avail - used);
    netted.set(i, Math.sign(it.amountCents) * (size - used));
  }
  const out = items
    .map((it, i) => ({ ...it, amountCents: netted.get(i) as number }))
    .filter((it) => it.amountCents !== 0);
  return { items: out, unused: [...left].filter(([, c]) => c > 0).map(([entityId, cents]) => ({ entityId, cents })) };
}
