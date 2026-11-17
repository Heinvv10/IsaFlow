import { describe, it, expect } from 'vitest';
import { runEngine } from '@/modules/accounting/services/cashForecast13/engine';
import type { EngineInput, KnownItem, Override } from '@/modules/accounting/services/cashForecast13/types';

const NO_OVERDUE = { totalCents: 0, beyondHorizonCents: 0, invoiceCount: 0, byBasis: { history: 0, no_history: 0 }, disputedCents: 0 };
const base = (over: Partial<EngineInput>): EngineInput => ({
  today: '2026-11-18', openingCents: 0, items: [], budget: null, manualItems: [], overrides: [], overdueAR: NO_OVERDUE, warnings: [], ...over,
});
// week 1 = 2026-11-16..22, week 2 = 11-23..29, week 3 = 11-30..12-06
const known: KnownItem = { lineKey: 'ap:s', lineLabel: 'S', category: 'supplier_payments', date: '2026-11-24', amountCents: -500, ref: 'b1', refLabel: 'B1' };
const closing = (out: ReturnType<typeof runEngine>) => out.weeks[12]!.closingCents;
const cell = (out: ReturnType<typeof runEngine>, key: string, w: number) =>
  out.lines.filter((l) => l.key === key || l.key === `override:${key}`).reduce((t, l) => t + (l.weekly[w] as number), 0);

describe('cash13 manual items', () => {
  it('adds a one-off manual line with kind manual', () => {
    const out = runEngine(base({ manualItems: [{ id: 'm1', date: '2026-11-30', amountCents: 250, description: 'Grant', category: 'other' }] }));
    const line = out.lines.find((l) => l.key === 'manual:m1')!;
    expect(line).toMatchObject({ kind: 'manual', label: 'Grant', category: 'other' });
    expect(line.weekly[2]).toBe(250);
  });

  it('repeats weekly and monthly within the horizon and stops at until', () => {
    const out = runEngine(base({ manualItems: [
      { id: 'w', date: '2026-11-18', amountCents: -10, description: 'Rent', category: 'other', repeat: { frequency: 'weekly' } },
      { id: 'm', date: '2026-11-25', amountCents: -7, description: 'Lease', category: 'other', repeat: { frequency: 'monthly', until: '2027-01-01' } },
    ] }));
    expect(out.lines.find((l) => l.key === 'manual:w')!.weekly).toEqual(Array(13).fill(-10));
    expect(out.lines.find((l) => l.key === 'manual:m')!.totalCents).toBe(-14); // Nov 25, Dec 25
  });

  it('drops the past occurrences of a repeat but keeps a past one-off in week 1', () => {
    const out = runEngine(base({ manualItems: [
      { id: 'r', date: '2026-01-07', amountCents: -3, description: 'x', category: 'other', repeat: { frequency: 'monthly' } },
      { id: 'o', date: '2026-01-07', amountCents: 9, description: 'y', category: 'other' },
    ] }));
    expect(out.lines.find((l) => l.key === 'manual:r')!.items[0]?.date).toBe('2026-12-07');
    expect(out.lines.find((l) => l.key === 'manual:o')!.weekly[0]).toBe(9);
  });

  it('a monthly repeat from the 31st clamps to short months', () => {
    const out = runEngine(base({ today: '2027-01-04', manualItems: [
      { id: 'e', date: '2027-01-31', amountCents: 1, description: 'x', category: 'other', repeat: { frequency: 'monthly' } },
    ] }));
    expect(out.lines.find((l) => l.key === 'manual:e')!.items.map((i) => i.date)).toEqual(['2027-01-31', '2027-02-28', '2027-03-31']);
  });
});

describe('cash13 overrides', () => {
  it('set replaces the cell through an override line; the source line is untouched', () => {
    const overrides: Override[] = [{ lineKey: 'ap:s', weekIndex: 1, mode: 'set', amountCents: -800 }];
    const out = runEngine(base({ items: [known], overrides }));
    expect(out.lines.find((l) => l.key === 'ap:s')!.weekly[1]).toBe(-500);
    expect(out.lines.find((l) => l.key === 'override:ap:s')).toMatchObject({ kind: 'override', category: 'supplier_payments' });
    expect(cell(out, 'ap:s', 1)).toBe(-800);
    expect(closing(out)).toBe(-800);
  });

  it('add adds to the cell', () => {
    const out = runEngine(base({ items: [known], overrides: [{ lineKey: 'ap:s', weekIndex: 1, mode: 'add', amountCents: -100 }] }));
    expect(cell(out, 'ap:s', 1)).toBe(-600);
  });

  it('move_to moves the whole cell, or part of it, to the target week', () => {
    const whole = runEngine(base({ items: [known], overrides: [{ lineKey: 'ap:s', weekIndex: 1, mode: 'move_to', targetWeek: 4 }] }));
    expect([cell(whole, 'ap:s', 1), cell(whole, 'ap:s', 4)]).toEqual([0, -500]);
    expect(closing(whole)).toBe(-500);
    // The amount is a MAGNITUDE (the data layer stores it positive) applied in the cell's sign.
    const part = runEngine(base({ items: [known], overrides: [{ lineKey: 'ap:s', weekIndex: 1, mode: 'move_to', amountCents: 200, targetWeek: 4 }] }));
    expect([cell(part, 'ap:s', 1), cell(part, 'ap:s', 4)]).toEqual([-300, -200]);
  });

  it('move_to of R50k from a −R200k supplier cell moves −R50k; on a receipt cell it moves +; a negative magnitude is skipped', () => {
    const big: KnownItem = { ...known, amountCents: -200_000_00 };
    const pay = runEngine(base({ items: [big], overrides: [{ lineKey: 'ap:s', weekIndex: 1, mode: 'move_to', amountCents: 50_000_00, targetWeek: 3 }] }));
    expect([cell(pay, 'ap:s', 1), cell(pay, 'ap:s', 3)]).toEqual([-150_000_00, -50_000_00]);
    expect(closing(pay)).toBe(-200_000_00);
    const rec: KnownItem = { ...known, lineKey: 'ar:c:due', category: 'customer_receipts', amountCents: 900 };
    const r = runEngine(base({ items: [rec], overrides: [{ lineKey: 'ar:c:due', weekIndex: 1, mode: 'move_to', amountCents: 400, targetWeek: 0 }] }));
    expect([cell(r, 'ar:c:due', 0), cell(r, 'ar:c:due', 1)]).toEqual([400, 500]);
    const neg = runEngine(base({ items: [big], overrides: [{ lineKey: 'ap:s', weekIndex: 1, mode: 'move_to', amountCents: -5, targetWeek: 3 }] }));
    expect(neg.warnings.map((w) => w.code)).toEqual(['override_skipped']);
    expect(cell(neg, 'ap:s', 3)).toBe(0);
  });

  it('clamps a move to the cell: R50k from a −R30k cell moves −R30k and leaves 0, never flipping the sign (re-review L-a)', () => {
    const small: KnownItem = { ...known, amountCents: -30_000_00 };
    const out = runEngine(base({ items: [small], overrides: [{ lineKey: 'ap:s', weekIndex: 1, mode: 'move_to', amountCents: 50_000_00, targetWeek: 3 }] }));
    expect([cell(out, 'ap:s', 1), cell(out, 'ap:s', 3)]).toEqual([0, -30_000_00]);
  });

  it('a move from an empty cell does nothing and is skipped with a warning', () => {
    for (const amountCents of [100, null]) {
      const out = runEngine(base({ items: [known], overrides: [{ lineKey: 'ap:s', weekIndex: 5, mode: 'move_to', amountCents, targetWeek: 3 }] }));
      expect(out.lines.some((l) => l.kind === 'override')).toBe(false);
      expect(out.warnings.map((w) => w.code)).toEqual(['override_skipped']);
    }
  });

  it('applies in array order: set then add differs from add then set', () => {
    const set: Override = { lineKey: 'ap:s', weekIndex: 1, mode: 'set', amountCents: -800 };
    const add: Override = { lineKey: 'ap:s', weekIndex: 1, mode: 'add', amountCents: -100 };
    expect(cell(runEngine(base({ items: [known], overrides: [set, add] })), 'ap:s', 1)).toBe(-900);
    expect(cell(runEngine(base({ items: [known], overrides: [add, set] })), 'ap:s', 1)).toBe(-800);
  });

  it('applies to manual lines too (overrides come after manual items)', () => {
    const out = runEngine(base({
      manualItems: [{ id: 'm1', date: '2026-11-18', amountCents: 100, description: 'x', category: 'other' }],
      overrides: [{ lineKey: 'manual:m1', weekIndex: 0, mode: 'set', amountCents: 40 }],
    }));
    expect(cell(out, 'manual:m1', 0)).toBe(40);
  });

  it('skips an override on an unknown line or week, with a warning, and changes nothing', () => {
    const out = runEngine(base({ items: [known], overrides: [
      { lineKey: 'nope', weekIndex: 1, mode: 'add', amountCents: 5 },
      { lineKey: 'ap:s', weekIndex: 13, mode: 'add', amountCents: 5 },
      { lineKey: 'ap:s', weekIndex: 1, mode: 'move_to', targetWeek: -1 },
      { lineKey: 'ap:s', weekIndex: 1, mode: 'set' },
    ] }));
    expect(out.lines.some((l) => l.kind === 'override')).toBe(false);
    expect(out.warnings.filter((w) => w.code === 'override_skipped')).toHaveLength(4);
    expect(closing(out)).toBe(-500);
  });
});
