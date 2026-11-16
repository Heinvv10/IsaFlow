/**
 * The user's own changes, applied after every source line (stored by 999i, read by readStoredInputs):
 *   - manual items become `manual:<id>` lines, repeated weekly or monthly within the horizon. Past = done: a
 *     repeat's past occurrences are dropped, and a one-off dated before this week's Monday is not forecast but
 *     listed in a `manual_item_past` warning (so the user re-dates or deletes it); one dated earlier this week
 *     is in week 1. Receipts and supplier payments among them count as KNOWN for the budget fill;
 *   - overrides change one cell of a line. They never edit the line itself: each overridden line gets one
 *     `override:<key>` line holding the deltas, so the source figure stays visible beside the change.
 * Overrides apply in array order (the caller's stored order); an override naming a line or week that is
 * not there is skipped with a warning. Pure.
 */
import { formatCents } from '@/lib/money/formatMoney';
import { addDays, addMonthsToMonth, daysInMonth, type WeekSpan } from './weeks';
import { assertCents, emptyWeekly, foldItems } from './lines';
import { FORECAST_WEEKS, type ForecastLine, type ForecastWarning, type KnownItem, type ManualItem, type Override } from './types';

/** `date` moved by `n` months, keeping the day of month and clamping to short months (Jan 31 → Feb 28). */
function addMonthsClamped(date: string, n: number): string {
  const month = addMonthsToMonth(date.slice(0, 7), n);
  const day = Math.min(Number(date.slice(8, 10)), daysInMonth(month));
  return `${month}-${String(day).padStart(2, '0')}`;
}

/** A one-off before `weekStart` (this week's Monday) has none; a repeat's past occurrences are history and dropped. */
function occurrences(m: ManualItem, today: string, weekStart: string, horizonEnd: string): string[] {
  if (!m.repeat) return m.date < weekStart ? [] : [m.date];
  const until = m.repeat.until && m.repeat.until < horizonEnd ? m.repeat.until : horizonEnd;
  const out: string[] = [];
  for (let i = 0; ; i++) {
    const d = m.repeat.frequency === 'weekly' ? addDays(m.date, 7 * i) : addMonthsClamped(m.date, i);
    if (d > until) break;
    if (d >= today) out.push(d);
  }
  return out;
}

/** The manual items' dated occurrences inside the horizon, and the one-offs left out as past. */
export function manualKnownItems(manual: readonly ManualItem[], today: string, weeks: readonly WeekSpan[]): { items: KnownItem[]; past: ManualItem[] } {
  const weekStart = (weeks[0] as WeekSpan).start;
  const horizonEnd = (weeks[weeks.length - 1] as WeekSpan).end;
  const past = manual.filter((m) => !m.repeat && m.date < weekStart);
  const items: KnownItem[] = manual.flatMap((m) => occurrences(m, today, weekStart, horizonEnd).map((date) => ({
    lineKey: `manual:${m.id}`, lineLabel: m.description, category: m.category, date, amountCents: m.amountCents,
    ref: `${m.id}:${date}`, refLabel: m.description,
  })));
  return { items, past };
}

export function manualLines(manual: readonly ManualItem[], today: string, weeks: readonly WeekSpan[]): { lines: ForecastLine[]; warnings: ForecastWarning[] } {
  const { items, past } = manualKnownItems(manual, today, weeks);
  const warnings: ForecastWarning[] = past.length === 0 ? [] : [{
    code: 'manual_item_past', source: 'manual items',
    message: `${past.length} one-off manual item(s) dated before this week are not forecast; re-date or delete them: ${
      [...past].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1))
        .map((m) => `"${m.description}" ${m.date} ${formatCents(m.amountCents)}`).join('; ')}`,
  }];
  return { lines: foldItems(items, 'manual', today, weeks).lines, warnings };
}

const validWeek = (w: number | null | undefined): w is number => typeof w === 'number' && Number.isInteger(w) && w >= 0 && w < FORECAST_WEEKS;

function skip(o: Override, why: string): ForecastWarning {
  return { code: 'override_skipped', source: 'overrides', message: `Override on ${o.lineKey} week ${o.weekIndex + 1} skipped: ${why}` };
}

/** Applies `overrides` to `lines`; returns the override lines to add and the skipped ones as warnings. */
export function applyOverrides(lines: readonly ForecastLine[], overrides: readonly Override[]): { lines: ForecastLine[]; warnings: ForecastWarning[] } {
  const source = new Map(lines.filter((l) => l.kind !== 'override').map((l) => [l.key, l]));
  const deltas = new Map<string, ForecastLine>();
  const warnings: ForecastWarning[] = [];
  for (const o of overrides) {
    const line = source.get(o.lineKey);
    if (!line) { warnings.push(skip(o, 'no such line')); continue; }
    if (!validWeek(o.weekIndex)) { warnings.push(skip(o, 'week out of range')); continue; }
    const hasAmount = typeof o.amountCents === 'number';
    if (hasAmount) assertCents(o.amountCents as number, `override on ${o.lineKey}`);
    if (o.mode !== 'move_to' && !hasAmount) { warnings.push(skip(o, 'no amount')); continue; }
    if (o.mode === 'move_to' && !validWeek(o.targetWeek)) { warnings.push(skip(o, 'target week out of range')); continue; }
    if (o.mode === 'move_to' && hasAmount && (o.amountCents as number) < 0) { warnings.push(skip(o, 'a move amount is a magnitude and cannot be negative')); continue; }
    if (o.mode === 'move_to' && (line.weekly[o.weekIndex] as number) + (deltas.get(o.lineKey)?.weekly[o.weekIndex] ?? 0) === 0) {
      warnings.push(skip(o, 'the cell is empty, nothing to move'));
      continue;
    }
    let delta = deltas.get(o.lineKey);
    if (!delta) {
      delta = { key: `override:${o.lineKey}`, label: `Adjustment: ${line.label}`, category: line.category, kind: 'override', weekly: emptyWeekly(), totalCents: 0, flags: [], items: [] };
      deltas.set(o.lineKey, delta);
    }
    const current = (w: number) => (line.weekly[w] as number) + (delta.weekly[w] as number);
    const w = o.weekIndex;
    if (o.mode === 'set') delta.weekly[w] = (delta.weekly[w] as number) + (o.amountCents as number) - current(w);
    else if (o.mode === 'add') delta.weekly[w] = (delta.weekly[w] as number) + (o.amountCents as number);
    else {
      // A given amount is a MAGNITUDE, moved in the cell's own sign and never more than the cell holds:
      // R50k of a −R200k supplier cell moves −R50k; R50k of a −R30k cell moves −R30k and leaves 0.
      const cur = current(w);
      const moved = hasAmount ? Math.sign(cur) * Math.min(o.amountCents as number, Math.abs(cur)) : cur;
      const t = o.targetWeek as number;
      delta.weekly[w] = (delta.weekly[w] as number) - moved;
      delta.weekly[t] = (delta.weekly[t] as number) + moved;
    }
  }
  for (const d of deltas.values()) d.totalCents = d.weekly.reduce((a, b) => a + b, 0);
  return { lines: [...deltas.values()], warnings };
}
