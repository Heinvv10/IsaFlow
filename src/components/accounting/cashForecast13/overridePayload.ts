/**
 * The cell editor's draft → the PUT /api/accounting/cash-forecast-13/overrides body (data layer #1509,
 * storeSchemas.OverrideInput). Pure.
 *
 * The person types a positive MAGNITUDE and chooses Money in or Money out; set/add go out SIGNED by that choice
 * (the data layer stores them signed). The choice defaults to `cellSign`: the cell's sign when it holds money,
 * else the line total's, else the first non-zero week's, else the category's (receipts in, the rest out). The
 * preview says what the week will be before Save, so a payment can never quietly become a receipt.
 * move_to sends a MAGNITUDE (> 0), or null for the whole cell, and the target Monday; the engine moves it in the
 * cell's sign and never past what the cell holds. `line` is the line AS IN FORCE (source + earlier changes).
 */
import { formatCents } from '@/lib/money/formatMoney';
import type { ForecastLine, ForecastWeek } from '@/modules/accounting/services/cashForecast13/types';

export type OverrideMode = 'set' | 'add' | 'move_to';
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

/** The stored override as the editor reads it (#1509 overridesRepo.StoredOverride). */
export interface ExistingOverride {
  id: string;
  lineKey: string;
  weekStart: string;
  mode: OverrideMode;
  amount: number | null;
  targetWeekStart?: string;
  note: string | null;
}

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

/** "Week 8 will be −R 20 000.00." for a complete draft (what the engine will do), else null. */
export function previewText(draft: OverrideDraft, line: ForecastLine, week: number, weeks: readonly ForecastWeek[]): string | null {
  const built = buildOverrideBody(draft, line, week, weeks);
  return built.ok ? describe(draft, built.body, line, week) : null; // an incomplete draft has nothing to state yet
}

function describe(draft: OverrideDraft, body: OverrideBody, line: ForecastLine, week: number): string {
  const cell = line.weekly[week] ?? 0;
  const amountCents = body.amount === null ? null : Math.round(body.amount * 100);
  if (draft.mode === 'move_to') {
    const t = draft.targetWeek as number;
    const moved = amountCents === null ? cell : Math.sign(cell) * Math.min(amountCents, Math.abs(cell));
    return `Week ${week + 1} will be ${formatCents(cell - moved)} and week ${t + 1} will be ${formatCents((line.weekly[t] ?? 0) + moved)}.`;
  }
  const result = draft.mode === 'set' ? (amountCents as number) : cell + (amountCents as number);
  return `Week ${week + 1} will be ${formatCents(result)}.`;
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
