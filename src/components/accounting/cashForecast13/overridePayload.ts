/**
 * The cell editor's draft → the PUT /api/accounting/cash-forecast-13/overrides body (data layer #1509,
 * storeSchemas.OverrideInput). Pure.
 *
 * The person types amounts as they read them (a payment of R6 000 is "6 000"). The data layer stores set/add
 * SIGNED in the line's own sign, so the typed figure is multiplied by the cell's sign: the cell's own when it holds
 * money (a refund week on a payments line stays positive), else the line's, else its category's (receipts in, the
 * rest out). A negative "add" means less. move_to sends a MAGNITUDE (> 0), or null for the whole cell, and the
 * target week's Monday; the engine moves it in the cell's sign and never past what the cell holds.
 */
import type { ForecastLine, ForecastWeek } from '@/modules/accounting/services/cashForecast13/types';

export type OverrideMode = 'set' | 'add' | 'move_to';

export interface OverrideDraft {
  mode: OverrideMode;
  /** What the person typed, in cents, unsigned as read (add may be negative). */
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

export type OverrideBodyResult = { ok: true; body: OverrideBody } | { ok: false; message: string };

const signOf = (n: number): 1 | -1 | 0 => (n > 0 ? 1 : n < 0 ? -1 : 0);

/** The sign a typed amount takes in this cell: the cell's, else the line's, else its category's. */
export function cellSign(line: Pick<ForecastLine, 'weekly' | 'totalCents' | 'category'>, week: number): 1 | -1 {
  const own = signOf(line.weekly[week] ?? 0);
  if (own !== 0) return own;
  const total = signOf(line.totalCents);
  if (total !== 0) return total;
  const first = line.weekly.find((v) => v !== 0);
  if (first !== undefined) return signOf(first) as 1 | -1;
  return line.category === 'customer_receipts' ? 1 : -1;
}

/** Cents → rand with two decimals; never -0 (JSON would send 0, but a 0 must read as 0 everywhere). */
const toRand = (cents: number): number => (cents === 0 ? 0 : cents / 100);

export function buildOverrideBody(draft: OverrideDraft, line: ForecastLine, week: number, weeks: readonly ForecastWeek[]): OverrideBodyResult {
  const weekStart = weeks[week]?.start;
  if (!weekStart) return { ok: false, message: 'That week is not in this forecast.' };
  const note = draft.note.trim() || null;
  const base = { lineKey: line.key, weekStart, note };
  if (draft.mode === 'move_to') {
    const target = draft.targetWeek === null ? undefined : weeks[draft.targetWeek]?.start;
    if (!target) return { ok: false, message: 'Choose the week to move it to.' };
    if (draft.targetWeek === week) return { ok: false, message: 'Choose a different week to move it to.' };
    if ((line.weekly[week] ?? 0) === 0) return { ok: false, message: 'This week has nothing to move.' };
    if (draft.wholeCell) return { ok: true, body: { ...base, mode: 'move_to', amount: null, targetWeekStart: target } };
    if (draft.amountCents === null || draft.amountCents <= 0) return { ok: false, message: 'Enter the amount to move, more than 0, or move the whole week.' };
    return { ok: true, body: { ...base, mode: 'move_to', amount: toRand(Math.abs(draft.amountCents)), targetWeekStart: target } };
  }
  if (draft.amountCents === null) return { ok: false, message: 'Enter an amount.' };
  if (draft.mode === 'add' && draft.amountCents === 0) return { ok: false, message: 'Enter an amount to add, other than 0.' };
  const signed = cellSign(line, week) * draft.amountCents;
  return { ok: true, body: { ...base, mode: draft.mode, amount: toRand(signed) } };
}
