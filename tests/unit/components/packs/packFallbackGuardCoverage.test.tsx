/**
 * Runs under vitest.components.config.ts (happy-dom): `bun run test:components`.
 *
 * THE FALLBACK GUARD SEES EVERY GLYPH THE FIT MODEL PRICES, AND SEES IT ONCE THE PAGES ARE THERE.
 *
 * `packFallbackGuard.MODELLED_TEXT` is the list of positions whose text the fit model measures. Every text node of a
 * rendered KPI tile and statement table lies inside one of them, save the two the model never measures (a table's
 * scale caption, a tile's sparkline). A space counts like any other character: U+3000, U+205F and U+1680 are outside the
 * self-hosted faces (priced from the image's table) and take the check. And the check runs once the pack's pages are
 * in the DOM, however late its data arrives after its fonts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { log } from '@/lib/logger';
import { PackBlocks } from '@/components/accounting/packs/pages/PackBlocks';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import { MODELLED_TEXT, usesFallbackGlyphs } from '@/components/accounting/packs/packFallbackGuard';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { stampFigureFits } from '@/modules/accounting/services/packs/pages/packFigureFitStamp';
import type { StampedPackPagesDocument } from '@/modules/accounting/services/packs/pages/packFigureFitCss';
import type { PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';
import { input, type Shape } from '../../services/packs/fixtures/packGridInputs';
import { SCALE } from '../../services/packs/fixtures/widenedFigures';

const SHAPES: Shape[] = [
  { tr: 'demo', budget: true, prior: true, negative: false, loss: false, k: 1, plug: 0.05, sg: [1, 1, 1, 1] },
  { tr: 'zero', budget: false, prior: true, negative: true, loss: true, k: 1000, plug: 0, sg: [-1, 1, -1, 1] },
  { tr: 'none', budget: true, prior: false, negative: false, loss: true, k: 3, plug: 0.2, sg: [1, -1, 1, -1] },
];

function pack(shape: Shape, edit?: (doc: PackPagesDocument) => void): StampedPackPagesDocument {
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  try {
    const doc = buildBoardPackPages(input(shape));
    edit?.(doc);
    return stampFigureFits(doc);
  } finally {
    warn.mockRestore();
  }
}

/** A pack whose first KPI tile's label is `label` and whose fourth tile is not meaningful, for `reason`. */
const withTileWords = (label: string, reason = 'Not meaningful: no revenue in the period.') => pack(SHAPES[0]!, (doc) => {
  const block = doc.pages.flatMap((p) => p.blocks).find((b) => b.kind === 'kpiTiles');
  if (block?.kind !== 'kpiTiles') throw new Error('no KPI row');
  block.tiles[0]!.label = label;
  block.tiles[3]!.figure = { ...block.tiles[3]!.figure, value: null, unavailable: reason };
});

const UNMODELLED = 'caption, .pack-kpi-sparkline';

function textNodes(root: Element): Text[] {
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const out: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) out.push(node as Text);
  return out;
}

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-print-error-fonts');
  document.documentElement.removeAttribute('data-print-error-pages');
});

describe('MODELLED_TEXT covers every text the fit model measures', () => {
  it('every text node of every KPI tile and statement table is in a modelled position, or one the model never measures', () => {
    let tiles = 0;
    let tables = 0;
    const uncovered: string[] = [];
    const reached = new Set<string>();
    for (const doc of [...SHAPES.map((shape) => pack(shape)), withTileWords('Gross margin')]) {
      for (const page of doc.pages) {
        const { container } = render(<PackBlocks page={page} scale={SCALE} />);
        for (const root of Array.from(container.querySelectorAll('.pack-kpi-tile, table.pack-table'))) {
          if (root.matches('.pack-kpi-tile')) tiles += 1; else tables += 1;
          for (const node of textNodes(root)) {
            if ((node.textContent ?? '').trim() === '' || node.parentElement!.closest(UNMODELLED) !== null) continue;
            const at = node.parentElement!.closest(MODELLED_TEXT);
            if (at === null) uncovered.push(`page ${page.number}: ${JSON.stringify(node.textContent)} in <${node.parentElement!.tagName.toLowerCase()} class="${node.parentElement!.className}">`);
            else reached.add(MODELLED_TEXT.split(', ').find((sel) => at.matches(sel))!);
          }
        }
        cleanup();
      }
    }
    expect(uncovered).toEqual([]);
    expect(tiles).toBeGreaterThan(0);
    expect(tables).toBeGreaterThan(0);
    // Every selector is one a real pack reaches: a list padded with positions nothing prints would hide a missing one.
    expect([...reached].sort()).toEqual(MODELLED_TEXT.split(', ').sort());
  });
});

describe('usesFallbackGlyphs', () => {
  const uses = (doc: StampedPackPagesDocument) => {
    const { container } = render(<>{doc.pages.map((page) => <PackBlocks key={page.number} page={page} scale={SCALE} />)}</>);
    return usesFallbackGlyphs(container);
  };

  it('a pack set wholly in the self-hosted faces, NBSP and the other spaces they cover included, takes no check', () => {
    expect(uses(withTileWords('Gross margin and more'))).toBe(false);
  });

  it.each([['U+3000', '　'], ['U+205F', ' '], ['U+1680', ' ']])('a %s space outside the faces takes the check', (name, space) => {
    expect(uses(withTileWords(`Gross${space}margin`))).toBe(true);
    expect(uses(withTileWords('Gross margin', `Not${space}meaningful`))).toBe(true);
  });

  it('a fallback glyph in a figure or a heading takes the check, not only in a label', () => {
    const { container } = render(<PackBlocks page={pack(SHAPES[0]!).pages.find((p) => p.blocks.some((b) => b.kind === 'kpiTiles'))!} scale={SCALE} />);
    expect(usesFallbackGlyphs(container)).toBe(false);
    container.querySelector('.pack-kpi-value')!.textContent = 'R　1';
    expect(usesFallbackGlyphs(container)).toBe(true);
    cleanup();
    const tablePage = pack(SHAPES[0]!).pages.find((p) => p.blocks.some((b) => b.kind === 'table'))!;
    const table = render(<PackBlocks page={tablePage} scale={SCALE} />).container;
    table.querySelector('.pack-table th:last-child')!.textContent = 'ACTUAL★';
    expect(usesFallbackGlyphs(table)).toBe(true);
  });
});

describe('the fallback check runs once the pages are in the DOM', () => {
  // `reportError` is real under happy-dom and vitest fails the run on every error it reports; the page raises one by
  // design when it marks itself unprintable.
  beforeEach(() => { vi.stubGlobal('reportError', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  // happy-dom lays nothing out, so the fingerprint measures 0 everywhere and differs from the image's: a pack that
  // takes the check is refused here, one that does not prints.
  it.each([
    ['takes the check and is refused', '　', 'false', true],
    ['takes no check and prints', ' ', 'true', false],
  ])('a pack whose data arrives after its fonts %s', async (what, space, ready, refused) => {
    const doc = withTileWords(`Gross${space}margin`);
    const view = render(<PackPagesView document={null} />);
    // The fonts settle (happy-dom has no FontFaceSet: ready at once) with no data and so no pages.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(document.documentElement.hasAttribute('data-print-error-fonts')).toBe(false);
    view.rerender(<PackPagesView document={doc} />);
    await waitFor(() => expect(view.container.querySelector(`[data-print-ready="${ready}"]`)).not.toBeNull());
    await waitFor(() => expect(document.documentElement.hasAttribute('data-print-error-fonts')).toBe(refused));
    expect(view.container.querySelectorAll('.pack-kpi-tile').length).toBeGreaterThan(0);
  });
});
