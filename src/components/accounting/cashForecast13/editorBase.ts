/**
 * The cell editor's arithmetic IS the engine's (pure `applyOverrides`), so what it previews is what the forecast
 * will show after Save.
 *
 * A save REPLACES the cell's stored override (#1509's PUT upserts per company + line + week). So the editor's BASE
 * is the source line with every stored override of that line EXCEPT this cell's own, applied in stored order;
 * the preview applies the draft on top of that base. Stored overrides map to the engine's week indexes with the
 * engineAdapter's own `weekOffset`, as its toEngineOverrides does: whole weeks from the forecast's first Monday, a cell outside the 13 weeks dropped, a move
 * target outside passed on for the engine to skip.
 */
import { applyOverrides } from '@/modules/accounting/services/cashForecast13/adjustments';
import { toCents } from '@/modules/accounting/services/cashForecast13/lines';
import { weekOffset } from '@/modules/accounting/services/cashForecast13/engineAdapter';
import { FORECAST_WEEKS, type ForecastLine, type ForecastWeek, type Override } from '@/modules/accounting/services/cashForecast13/types';
import { formatCents } from '@/lib/money/formatMoney';
import type { ExistingOverride, OverrideBody } from './overridePayload';

type Stored = Omit<ExistingOverride, 'id' | 'note'>;

/** Stored (rand, Mondays) → the engine's overrides (cents, week indexes), in the order given. */
export function toEngineOverrides(stored: readonly Stored[], weeks: readonly ForecastWeek[]): Override[] {
  const first = weeks[0]?.start;
  if (!first) return [];
  const out: Override[] = [];
  for (const o of stored) {
    const weekIndex = weekOffset(first, o.weekStart);
    if (weekIndex < 0 || weekIndex >= FORECAST_WEEKS) continue;
    const e: Override = { lineKey: o.lineKey, weekIndex, mode: o.mode, amountCents: o.amount === null ? null : toCents(o.amount) };
    if (o.mode === 'move_to' && o.targetWeekStart) e.targetWeek = weekOffset(first, o.targetWeekStart);
    out.push(e);
  }
  return out;
}

/** The source line with these engine overrides applied (the engine's arithmetic; skipped ones change nothing). */
export function withOverrides(source: ForecastLine, overrides: readonly Override[]): ForecastLine {
  const own = overrides.filter((o) => o.lineKey === source.key);
  if (own.length === 0) return source;
  const delta = applyOverrides([source], own).lines[0];
  if (!delta) return source;
  const weekly = source.weekly.map((v, w) => v + (delta.weekly[w] ?? 0));
  return { ...source, weekly, totalCents: weekly.reduce((a, b) => a + b, 0) };
}

/** The editor's base: every stored override of the line except this cell's own (which a save replaces). */
export function editorBase(source: ForecastLine, stored: readonly Stored[], week: number, weeks: readonly ForecastWeek[]): ForecastLine {
  const start = weeks[week]?.start;
  const others = stored.filter((o) => o.lineKey === source.key && o.weekStart !== start);
  return withOverrides(source, toEngineOverrides(others, weeks));
}

/** The body as the engine's override for this cell. */
function bodyAsOverride(body: OverrideBody, weeks: readonly ForecastWeek[]): Override[] {
  return toEngineOverrides([{ lineKey: body.lineKey, weekStart: body.weekStart, mode: body.mode, amount: body.amount, ...(body.targetWeekStart ? { targetWeekStart: body.targetWeekStart } : {}) }], weeks);
}

/**
 * A save whose mode, amount and target equal the stored override's (unchanged, or the note only) keeps the row's
 * place in the application order (999i restamps applied_at only when they change), so the figures do not move:
 * "draft applied last" would mislead when a later change moved money into this week.
 */
export function isNoOpResave(body: OverrideBody, existing: Omit<ExistingOverride, 'id' | 'note'> | undefined): boolean {
  if (!existing || existing.mode !== body.mode) return false;
  const cents = (a: number | null) => (a === null ? null : toCents(a));
  return cents(existing.amount) === cents(body.amount) && (existing.targetWeekStart ?? null) === (body.targetWeekStart ?? null);
}

/** "Week 8 will be −R 20 000.00." (a move names both weeks): the engine's result of `body` on the base. */
export function previewOf(body: OverrideBody, base: ForecastLine, week: number, targetWeek: number | null, weeks: readonly ForecastWeek[]): string {
  const after = withOverrides(base, bodyAsOverride(body, weeks));
  const here = `Week ${week + 1} will be ${formatCents(after.weekly[week] ?? 0)}`;
  if (body.mode !== 'move_to' || targetWeek === null) return `${here}.`;
  return `${here} and week ${targetWeek + 1} will be ${formatCents(after.weekly[targetWeek] ?? 0)}.`;
}
