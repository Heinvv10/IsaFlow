/**
 * The cell editor's draft → the PUT /api/accounting/cash-forecast-13/overrides body (data layer #1509,
 * storeSchemas.OverrideInput). Pure.
 *
 * The person types a positive MAGNITUDE and chooses Money in or Money out; set/add go out SIGNED by that choice
 * (the data layer stores them signed). The choice defaults to `cellSign`: the cell's sign when it holds money,
 * else the line total's, else the first non-zero week's, else the category's (receipts in, the rest out). The
 * editor previews the result before Save (editorBase.ts, the engine's arithmetic), so a payment can never quietly
 * become a receipt.
 * move_to sends a MAGNITUDE (> 0), or null for the whole cell, and the target Monday; the engine moves it in the
 * cell's sign and never past what the cell holds. `line` is the editor's BASE (editorBase.ts): the source with
 * every stored change except this cell's own, which a save replaces.
 */
import type { ForecastLine, ForecastWeek } from '@/modules/accounting/services/cashForecast13/types';
import type { StoredOverride } from '@/modules/accounting/services/cashForecast13/overridesRepo';
import type { OverrideMode } from '@/modules/accounting/services/cashForecast13/storeTypes';
import type { OverrideInput } from '@/modules/accounting/services/cashForecast13/storeSchemas';
import type { z } from 'zod';

export type { OverrideMode };
export type Direction = 1 | -1;

export interface OverrideDraft {
  mode: OverrideMode;
  /** set/add: Money in (1) or Money out (-1). */
  direction: Direction;
  /** What the person typed, in cents: a magnitude (never negative). */
  amountCents: number | null;
  /** move_to only: move everything in the cell. */
  wholeCell: boolean;
  /** move_to only: the target week's index (0-12). */
  targetWeek: number | null;
  note: string;
}

export interface OverrideBody {
  lineKey: string;
  weekStart: string;
  mode: OverrideMode;
  amount: number | null;
  targetWeekStart?: string;
  note: string | null;
}

/**
 * The body is the route's schema (storeSchemas.OverrideInput): every field of ours is a valid input to it, with
 * the same field names both ways. A field added, renamed or retyped in the schema fails tsc here.
 */
type OverrideWire = z.input<typeof OverrideInput>;
type SameKeys<A, B> = [Exclude<keyof A, keyof B>, Exclude<keyof B, keyof A>] extends [never, never] ? true : false;
const overrideBodyMatchesSchema: [OverrideBody extends OverrideWire ? true : false, SameKeys<OverrideBody, OverrideWire>] = [true, true];
void overrideBodyMatchesSchema;

/** The stored override as the editor reads it (the fields of overridesRepo.StoredOverride it uses). */
export type ExistingOverride = Pick<StoredOverride, 'id' | 'lineKey' | 'weekStart' | 'mode' | 'amount' | 'targetWeekStart' | 'note'>;

export type OverrideBodyResult = { ok: true; body: OverrideBody } | { ok: false; message: string };

const signOf = (n: number): 1 | -1 | 0 => (n > 0 ? 1 : n < 0 ? -1 : 0);

/** The default direction for this cell: the cell's, else the line total's, else the first non-zero week's, else its category's. */
export function cellSign(line: Pick<ForecastLine, 'weekly' | 'totalCents' | 'category'>, week: number): Direction {
  const own = signOf(line.weekly[week] ?? 0);
  if (own !== 0) return own;
  const total = signOf(line.totalCents);
  if (total !== 0) return total;
  const first = line.weekly.find((v) => v !== 0);
  if (first !== undefined) return signOf(first) as Direction;
  return line.category === 'customer_receipts' ? 1 : -1;
}

/** Cents → rand with two decimals; never -0. */
const toRand = (cents: number): number => (cents === 0 ? 0 : cents / 100);

export function buildOverrideBody(draft: OverrideDraft, line: ForecastLine, week: number, weeks: readonly ForecastWeek[]): OverrideBodyResult {
  const weekStart = weeks[week]?.start;
  if (!weekStart) return { ok: false, message: 'That week is not in this forecast.' };
  const note = draft.note.trim() || null;
  const base = { lineKey: line.key, weekStart, note };
  if (draft.amountCents !== null && draft.amountCents < 0) return { ok: false, message: 'Enter the amount without a minus sign, and choose Money in or Money out.' };
  if (draft.mode === 'move_to') {
    const target = draft.targetWeek === null ? undefined : weeks[draft.targetWeek]?.start;
    if (!target) return { ok: false, message: 'Choose the week to move it to.' };
    if (draft.targetWeek === week) return { ok: false, message: 'Choose a different week to move it to.' };
    if ((line.weekly[week] ?? 0) === 0) return { ok: false, message: 'This week has nothing to move.' };
    if (draft.wholeCell) return { ok: true, body: { ...base, mode: 'move_to', amount: null, targetWeekStart: target } };
    if (draft.amountCents === null || draft.amountCents <= 0) return { ok: false, message: 'Enter the amount to move, more than 0, or move the whole week.' };
    return { ok: true, body: { ...base, mode: 'move_to', amount: toRand(draft.amountCents), targetWeekStart: target } };
  }
  if (draft.amountCents === null) return { ok: false, message: 'Enter an amount.' };
  if (draft.mode === 'add' && draft.amountCents === 0) return { ok: false, message: 'Enter an amount to add, other than 0.' };
  return { ok: true, body: { ...base, mode: draft.mode, amount: toRand(draft.direction * draft.amountCents) } };
}

/** The stored override as a draft, so a re-save (which replaces it) starts from what is stored. */
export function draftFromOverride(o: ExistingOverride, line: ForecastLine, week: number, weeks: readonly ForecastWeek[]): OverrideDraft {
  const note = o.note ?? '';
  if (o.mode === 'move_to') {
    const t = weeks.findIndex((w) => w.start === o.targetWeekStart);
    return {
      mode: 'move_to', direction: cellSign(line, week), amountCents: o.amount === null ? null : Math.round(o.amount * 100),
      wholeCell: o.amount === null, targetWeek: t < 0 ? null : t, note,
    };
  }
  const amount = o.amount ?? 0;
  const direction = amount === 0 ? cellSign(line, week) : (signOf(amount) as Direction);
  return { mode: o.mode, direction, amountCents: Math.round(Math.abs(amount) * 100), wholeCell: false, targetWeek: null, note };
}
