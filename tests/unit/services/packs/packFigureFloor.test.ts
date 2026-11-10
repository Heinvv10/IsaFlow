/**
 * A pack whose figures fit at no size down to the pack's smallest text is refused, not printed past the sheet's
 * edge. That cannot be reached through the composer with a real revenue (a R9e15 revenue prints in 13 digits and
 * still fits), so the refusal is held here on the composed demo pack with its figures widened afterwards, and
 * its wiring into the composer by a spy; the thresholds against Chromium are `packFigureFitThreshold.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('@/modules/accounting/services/packs/pages/packFigureFloor', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/packs/pages/packFigureFloor')>();
  return { ...actual, assertFiguresReadable: (...args: Parameters<typeof actual.assertFiguresReadable>) => { gate.calls.push(args); return actual.assertFiguresReadable(...args); } };
});
import { log } from '@/lib/logger';
import { packRefusalMessages, PackRefusal } from '@/modules/accounting/services/packs/packRefusal';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { assertFiguresReadable, unreadableBlock } from '@/modules/accounting/services/packs/pages/packFigureFloor';
import { demoInput } from './fixtures/boardPackInputs';
import { demoWithoutBudget, SCALE, withWidenedKpi, withWidenedTable } from './fixtures/widenedFigures';
import { relabelledStatement } from '../../print/fixtures/markedTables';

const refusalOf = (fn: () => void): PackRefusal => {
  try { fn(); } catch (err) { if (err instanceof PackRefusal) return err; throw err; }
  throw new Error('no refusal');
};

describe('assertFiguresReadable', () => {
  it('passes the demo pack', () => {
    expect(() => assertFiguresReadable(demoWithoutBudget().pages, SCALE)).not.toThrow();
  });

  it('refuses a table whose figures fit at no size, in two registers', () => {
    const { doc } = withWidenedTable(demoWithoutBudget(), 40);
    const refusal = refusalOf(() => assertFiguresReadable(doc.pages, SCALE));
    const { user, diagnostic } = packRefusalMessages(refusal);
    expect(diagnostic).toMatch(/"Income statement": a table whose figures fit at no size down to the pack's smallest text/);
    expect(user).toContain('too wide to print legibly');
    expect(user).not.toContain('assertFiguresReadable');
  });

  it('a table a label keeps from fitting is refused naming the label, not blaming the figures (#1235 round 9, blind L1)', () => {
    // A grapheme of four code points or more (an emoji ZWJ sequence, a conjunct) is a floor of 348px: no figure size
    // leaves room for it beside the demo's six columns. The figures alone fit.
    for (const label of ['Pride donations \u{1F3F3}\uFE0F\u200D\u{1F308}', 'Marketing \u2764\uFE0F\u200D\u{1F525}', '\u0915\u094D\u0937\u0947\u0924\u094D\u0930\u0940\u092F \u0915\u093E\u0930\u094D\u092F\u093E\u0932\u092F']) {
      for (const digits of [1, 6, 12]) {
        const { doc, index } = withWidenedTable(demoWithoutBudget(), digits, label);
        expect(withWidenedTable(demoWithoutBudget(), digits).table.figureFit!.fits).toBe(true);
        expect(unreadableBlock(doc.pages[index]!, SCALE)).toEqual({ kind: 'table', label });
        const { user, diagnostic } = packRefusalMessages(refusalOf(() => assertFiguresReadable(doc.pages, SCALE)));
        expect(diagnostic).toContain(`row label "${label}" holds a character the print cannot break`);
        expect(user).toContain(`row label, "${label}", that needs more room than its figures leave`);
        expect(user).not.toContain('too wide to print legibly');
      }
    }
    // One Arabic letter (a floor of 87px, a 7px letter): the table fits until the figures are at the edge, then the floor
    // alone tips it (#1235 round 10, blind L1). At 18 digits "Revenue" still fits, so the label is named; at 20 it does
    // not either, so the figures are.
    const arabic = '\u0628';
    expect(withWidenedTable(demoWithoutBudget(), 17, arabic).table.figureFit!.fits).toBe(true);
    expect(withWidenedTable(demoWithoutBudget(), 18, 'Revenue').table.figureFit!.fits).toBe(true);
    const at18 = withWidenedTable(demoWithoutBudget(), 18, arabic);
    expect(unreadableBlock(at18.doc.pages[at18.index]!, SCALE)).toEqual({ kind: 'table', label: arabic });
    const at21 = withWidenedTable(demoWithoutBudget(), 21, arabic);
    expect(unreadableBlock(at21.doc.pages[at21.index]!, SCALE)).toEqual({ kind: 'table' });
    // A label whose own width already leaves the figures no room is not blamed for its floor: the baseline is the label
    // at its widest piece, not at nothing (round 9 priced it at nothing and named "Telecommunications \u0628" here).
    for (const digits of [18, 19, 20, 21]) {
      const wide = withWidenedTable(demoWithoutBudget(), digits, `Telecommunications ${arabic}`);
      expect(unreadableBlock(wide.doc.pages[wide.index]!, SCALE), `${digits} digits`).toEqual({ kind: 'table' });
    }
    // Figures that fit at no size are still the figures, a marked label or not.
    const { doc, index } = withWidenedTable(demoWithoutBudget(), 40, 'Telecomq\u0301munications');
    expect(unreadableBlock(doc.pages[index]!, SCALE)).toEqual({ kind: 'table' });
    expect(packRefusalMessages(refusalOf(() => assertFiguresReadable(doc.pages, SCALE))).user).toContain('too wide to print legibly');
  });

  it('with several labels printed to break anywhere, names the one whose floor is the table\'s, not the first (round 10, blind L2)', () => {
    // A two-code-point grapheme first (174px), a four-code-point one later (348px): the later one keeps the table out.
    const narrow = 'Telecomq\u0301munications';
    const wide = 'Pride donations \u{1F3F3}\uFE0F\u200D\u{1F308}';
    const { doc, index } = relabelledStatement((label, i) => ({ label: i === 0 ? narrow : i === 3 ? wide : label }));
    const table = doc.pages[index]!.blocks.find((b) => b.kind === 'table')!;
    if (table.kind !== 'table') throw new Error('no table');
    expect(table.table.rows[0]!.label).toBe(narrow);
    expect(unreadableBlock(doc.pages[index]!, SCALE)).toEqual({ kind: 'table', label: wide });
    expect(refusalOf(() => assertFiguresReadable(doc.pages, SCALE)).message).toContain(`row label "${wide}"`);
  });

  it('refuses a KPI row the same way', () => {
    const { doc } = withWidenedKpi(demoWithoutBudget(), 40);
    const refusal = refusalOf(() => assertFiguresReadable(doc.pages, SCALE));
    expect(refusal.message).toMatch(/"Highlights": a KPI row/);
    expect(unreadableBlock(doc.pages[2]!, SCALE)).toEqual({ kind: 'kpi' });
  });
});

describe('the composer', () => {
  it('runs the gate over all twelve pages of every pack it builds', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      gate.calls.length = 0;
      expect(buildBoardPackPages(demoInput).pages).toHaveLength(12);
      expect(gate.calls).toHaveLength(1);
      expect((gate.calls[0]![0] as unknown[]).length).toBe(12);
    } finally {
      warn.mockRestore();
    }
  });
});
