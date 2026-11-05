/**
 * A pack whose figures cannot be set at the floor is refused, not printed small or cut off.
 *
 * The floors (12pt KPI figures, 7.5pt table figures) are in the stylesheet; `packFigureFloor.ts` repeats
 * the stylesheet's arithmetic so the composer can tell when the floor binds. Where figures fit, the
 * model says the ceiling (22pt / 9pt), which is what the stylesheet prints. The printed proof that the
 * model's ruler is never short of Chromium's is `tests/unit/print/packNothingPassesTheEdge.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';
import { packRefusalMessages, PackRefusal } from '@/modules/accounting/services/packs/packRefusal';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { kpiFigurePt, tableFigurePt, TABLE_FIGURE_FLOOR_PT, KPI_FIGURE_FLOOR_PT } from '@/modules/accounting/services/packs/pages/packFigureFloor';
import { demoInput } from './fixtures/boardPackInputs';
import { page6Input } from './fixtures/page6Shapes';

describe('the model of the stylesheet\'s figure size', () => {
  it('is the ceiling where the figures fit', () => {
    expect(kpiFigurePt(['126 000', '45.0%', '910', '610'])).toBe(22);
    expect(tableFigurePt([['126 000', '(1 546)'], ['45.0%'], ['n/m a']])).toBe(9);
    expect(tableFigurePt([['(126 000)'], ['45.0%'], ['1'], ['1'], ['1']])).toBe(9);
  });

  it('falls as the figures widen, to below the floor for a very wide row', () => {
    const narrow = kpiFigurePt(['(13 350 000)', '(13 350 000)', '(13 350 000)', '(13 350 000)'])!;
    const wide = kpiFigurePt(['(133 500 000 000 000 000)', '(133 500 000 000 000 000)', '(133 500 000 000 000 000)', '(133 500 000 000 000 000)'])!;
    expect(narrow).toBeLessThan(22);
    expect(wide).toBeLessThan(narrow);
    expect(wide).toBeLessThan(KPI_FIGURE_FLOOR_PT);
    expect(tableFigurePt(Array.from({ length: 7 }, () => ['1 260 000 000 000 000']))!).toBeLessThan(TABLE_FIGURE_FLOOR_PT);
  });

  it('is null for a block with no figures', () => {
    expect(kpiFigurePt([null, null])).toBeNull();
    expect(tableFigurePt([])).toBeNull();
  });
});

describe('the pack', () => {
  const build = (k: number) => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      return buildBoardPackPages(page6Input({ k, negative: false, loss: false, plug: 0, sg: [1, 1, 1, 1] }));
    } finally {
      warn.mockRestore();
    }
  };

  it('is produced where every figure fits at or above its floor (the demo, and R3 trillion-scale figures)', () => {
    expect(() => buildBoardPackPages(demoInput)).not.toThrow();
    expect(build(3_000_000).pages).toHaveLength(12);
  });

  it('is refused, in two registers, where a table\'s figures cannot be set at the floor (k = 1e8, and from about k = 2.7e7)', () => {
    let refusal: unknown;
    try { build(100_000_000); } catch (err) { refusal = err; }
    expect(refusal).toBeInstanceOf(PackRefusal);
    const { user, diagnostic } = packRefusalMessages(refusal);
    expect(diagnostic).toMatch(/"Income statement" needs its figures at \d\.\dpt and the floor is 7\.5pt/);
    expect(user).toContain('too wide to print legibly');
    expect(user).not.toContain('assertFiguresReadable');
  });
});
