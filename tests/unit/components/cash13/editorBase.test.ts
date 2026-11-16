/**
 * The editor's base and preview are the ENGINE's arithmetic on a state where the forecast and the store AGREE
 * (the forecast was run with the stored overrides, as #1509's route does). A save replaces the cell's own stored
 * override, so the base leaves exactly that one out; the preview applies the draft on the base. Reviewer cases:
 * a re-saved add (+250.50), a re-saved partial move (2 000 of -8 000) and a re-saved whole move.
 */
import { describe, expect, it } from 'vitest';
import { editorBase, isNoOpResave, previewOf, toEngineOverrides, withOverrides } from '@/components/accounting/cashForecast13/editorBase';
import { buildOverrideBody, draftFromOverride } from '@/components/accounting/cashForecast13/overridePayload';
import type { ExistingOverride } from '@/components/accounting/cashForecast13/overridePayload';
import { forecastFixture } from './fixture';

const weeks = forecastFixture({ overrides: [] }).weeks;
const W = (i: number) => weeks[i]!.start;
const sp = (t: string) => t.replace(/ /g, ' ');

/** The forecast the route would send for this store, and the AP line in it. */
function agree(stored: ExistingOverride[]) {
  const f = forecastFixture({ overrides: toEngineOverrides(stored, weeks) });
  return { f, ap: f.lines.find((l) => l.key === 'ap:s1')! };
}

/** Re-open the cell's stored change and preview a save of it unchanged: must equal the forecast in force. */
function resave(stored: ExistingOverride[], week: number) {
  const { f, ap } = agree(stored);
  const base = editorBase(ap, stored, week, f.weeks);
  const own = stored.find((o) => o.lineKey === 'ap:s1' && o.weekStart === W(week))!;
  const draft = draftFromOverride(own, base, week, f.weeks);
  const built = buildOverrideBody(draft, base, week, f.weeks);
  if (!built.ok) throw new Error(built.message);
  const inForce = withOverrides(ap, toEngineOverrides(stored, f.weeks));
  return { base, built, draft, inForce, preview: sp(previewOf(built.body, base, week, draft.mode === 'move_to' ? draft.targetWeek : null, f.weeks)) };
}

const o = (p: Partial<ExistingOverride>): ExistingOverride => ({ id: 'o1', lineKey: 'ap:s1', weekStart: W(1), mode: 'set', amount: 0, note: null, ...p });

describe('re-saving a changed week previews the engine\'s own result', () => {
  it('set: -6 000 stays -6 000', () => {
    const r = resave([o({ mode: 'set', amount: -6000 })], 1);
    expect(r.base.weekly[1]).toBe(-8_000_00);
    expect(r.preview).toBe('Week 2 will be −R 6 000.00.');
  });

  it('add +250.50 on -8 000: -7 749.50, not -7 499.00 (no double count)', () => {
    const r = resave([o({ mode: 'add', amount: 250.5 })], 1);
    expect(r.inForce.weekly[1]).toBe(-7_749_50);
    expect(r.preview).toBe('Week 2 will be −R 7 749.50.');
  });

  it('partial move of 2 000 to week 5: -6 000 / -2 000, not -4 000 / -4 000', () => {
    const r = resave([o({ mode: 'move_to', amount: 2000, targetWeekStart: W(4) })], 1);
    expect([r.inForce.weekly[1], r.inForce.weekly[4]]).toEqual([-6_000_00, -2_000_00]);
    expect(r.preview).toBe('Week 2 will be −R 6 000.00 and week 5 will be −R 2 000.00.');
  });

  it('a whole-week move can be re-saved: the base still holds the money', () => {
    const r = resave([o({ mode: 'move_to', amount: null, targetWeekStart: W(4) })], 1);
    expect(r.inForce.weekly[1]).toBe(0);
    expect(r.base.weekly[1]).toBe(-8_000_00);
    expect(r.built.body).toMatchObject({ mode: 'move_to', amount: null, targetWeekStart: W(4) });
    expect(r.preview).toBe('Week 2 will be R 0.00 and week 5 will be −R 8 000.00.');
  });
});

describe('the base keeps every OTHER change', () => {
  it('money moved INTO a week by another cell\'s change is in that week\'s base and can be moved on', () => {
    const stored = [o({ mode: 'move_to', amount: null, targetWeekStart: W(4) })];
    const { f, ap } = agree(stored);
    expect(editorBase(ap, stored, 4, f.weeks).weekly[4]).toBe(-8_000_00);
  });

  it('another line\'s changes never touch this line', () => {
    const stored = [o({ lineKey: 'payroll:net', mode: 'set', amount: 0 })];
    const { f, ap } = agree(stored);
    expect(editorBase(ap, stored, 1, f.weeks)).toBe(ap);
  });

  it('weeks map like the adapter: a cell outside the 13 weeks is dropped', () => {
    expect(toEngineOverrides([o({ weekStart: '2026-11-09' })], weeks)).toEqual([]);
    expect(toEngineOverrides([o({ weekStart: W(12), amount: -1 })], weeks)).toEqual([{ lineKey: 'ap:s1', weekIndex: 12, mode: 'set', amountCents: -100 }]);
  });
});

describe('isNoOpResave', () => {
  const set = o({ weekStart: W(4), mode: 'set', amount: -1000 });
  it('same mode, amount and target: no change (the row keeps its place)', () => {
    expect(isNoOpResave({ lineKey: 'ap:s1', weekStart: W(4), mode: 'set', amount: -1000, note: 'only the note' }, set)).toBe(true);
  });
  it('a different amount, mode or target is a change', () => {
    expect(isNoOpResave({ lineKey: 'ap:s1', weekStart: W(4), mode: 'set', amount: -2000, note: null }, set)).toBe(false);
    expect(isNoOpResave({ lineKey: 'ap:s1', weekStart: W(4), mode: 'add', amount: -1000, note: null }, set)).toBe(false);
    const mv = o({ mode: 'move_to', amount: null, targetWeekStart: W(4) });
    expect(isNoOpResave({ lineKey: 'ap:s1', weekStart: W(1), mode: 'move_to', amount: null, targetWeekStart: W(5), note: null }, mv)).toBe(false);
    expect(isNoOpResave({ lineKey: 'ap:s1', weekStart: W(1), mode: 'move_to', amount: null, targetWeekStart: W(4), note: null }, mv)).toBe(true);
  });
  it('no stored change: never a no-op', () => {
    expect(isNoOpResave({ lineKey: 'ap:s1', weekStart: W(4), mode: 'set', amount: -1000, note: null }, undefined)).toBe(false);
  });
});
