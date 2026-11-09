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
        expect(user).toContain(`row label, "${label}"`);
        expect(user).toContain('Your figures are not the problem');
        expect(user).not.toContain('too wide to print legibly');
      }
    }
    // Figures that fit at no size are still the figures, a marked label or not.
    const { doc, index } = withWidenedTable(demoWithoutBudget(), 40, 'Telecomq\u0301munications');
    expect(unreadableBlock(doc.pages[index]!, SCALE)).toEqual({ kind: 'table' });
    expect(packRefusalMessages(refusalOf(() => assertFiguresReadable(doc.pages, SCALE))).user).toContain('too wide to print legibly');
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
