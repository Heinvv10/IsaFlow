/** Small helpers shared by the generators: document numbers, VAT, invoice lines, day draws. */

import { formatDocumentNumber } from '../../../src/modules/accounting/services/core/companySettingsService';
import { daysBetween, dayOf, monthEnd, ym } from './dates';
import { between, type Rng } from './rng';
import type { Ctx, DocFamilyKey } from './types';

export function nextDocNumber(ctx: Ctx, family: DocFamilyKey): string {
  ctx.used[family] += 1;
  const f = ctx.input.docs[family];
  return formatDocumentNumber(f.prefix, ctx.used[family], f.padding);
}

/** VAT on a subtotal in cents, rounded to the cent. */
export function vatCents(subtotalCents: number, ratePct: number): number {
  return Math.round((subtotalCents * ratePct) / 100);
}

/** Upper-case short name for statement text: first two words, letters and digits only. */
export function shortName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean).slice(0, 2).join(' ');
}

/** A day in the month, never after `today` (for the current month: up to today). */
export function dayInMonth(rng: Rng, year: number, month: number, today: string): string {
  const cur = ym(today);
  const last = cur.year === year && cur.month === month ? Number(today.slice(8, 10)) : Number(monthEnd(year, month).slice(8, 10));
  return dayOf(year, month, between(rng, 1, last));
}

/** How many documents a month gets: the base count, a December/January dip, the current month pro rata. */
export function monthCount(rng: Rng, year: number, month: number, today: string, lo: number, hi: number): number {
  let n = between(rng, lo, hi);
  if (month === 12 || month === 1) n = Math.round(n * 0.85);
  const cur = ym(today);
  if (cur.year === year && cur.month === month) {
    const days = Number(monthEnd(year, month).slice(8, 10));
    n = Math.max(1, Math.round((n * Number(today.slice(8, 10))) / days));
  }
  return n;
}

export function ageDays(date: string, today: string): number {
  return daysBetween(date, today);
}

/** Fisher-Yates with the seeded PRNG. */
export function shuffled<T>(rng: Rng, items: readonly T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = between(rng, 0, i);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
