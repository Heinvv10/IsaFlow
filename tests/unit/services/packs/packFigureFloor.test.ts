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
