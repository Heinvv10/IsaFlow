/**
 * A page whose footnotes the fitter dropped, printed: every superscript on the sheet has its
 * footnote at the foot of the same sheet, the numbers run 1..n, and the pack is still twelve
 * sheets with nothing past the paper's edge. The inputs are shapes from the 2,560-input sweep
 * (`packFitterAnchorsSweep.test.ts`) that printed a superscript pointing at nothing, or at the
 * omission note, before the fix.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright';
import { launchPrintChromium } from './printChromium';
import { log } from '@/lib/logger';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import { assertPackIntegrity } from '@/modules/accounting/services/packs/figures/packFigureIntegrity';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { OMISSION_MARK } from '@/modules/accounting/services/packs/pages/packPageFit';
import { page6Input, type Page6Shape } from '../services/packs/fixtures/page6Shapes';
import { printBoardPack } from './renderPackPdf';

const SHAPES: Array<[string, Page6Shape]> = [
  ['demo scale, a profit', { k: 1, negative: false, loss: false, plug: 0.05, sg: [-1, -1, 1, -1] }],
  ['R1m scale, a profit', { k: 1000, negative: false, loss: false, plug: 0.03, sg: [-1, 1, 1, 1] }],
  // R300m fits with every footnote once prose is set at its own widths; R3m is among the largest scales that still drops one.
  ['R3m scale, a loss', { k: 3000, negative: false, loss: true, plug: 0.2, sg: [-1, 1, -1, 1] }],
];

let browser: Browser;
beforeAll(async () => { browser = await launchPrintChromium(); }, 180_000);
afterAll(async () => { await browser?.close(); });

/** The superscripts and the footnote list of page `id`, read off the markup the app renders. */
function renderedNumbers(markup: string, id: string): { markers: number[]; listed: number[]; omission: number[] } {
  const start = markup.indexOf(`id="${id}"`);
  const next = markup.indexOf('id="pack-page-', start + 1);
  const html = markup.slice(start, next === -1 ? undefined : next);
  const markers = [...html.matchAll(/class="pack-footnote-marker"[^>]*>(\d+)</g)].map((m) => Number(m[1]));
  const items = [...html.matchAll(/<span class="pack-footnote-number">(\d+)<\/span><span>([^<]*)<\/span>/g)];
  return {
    markers,
    listed: items.map((m) => Number(m[1])),
    omission: items.filter((m) => m[2]!.startsWith(OMISSION_MARK)).map((m) => Number(m[1])),
  };
}

describe.each(SHAPES)('page 6, %s', (unused, shape) => {
  it('prints twelve sheets, nothing of page 6 past the edge, every superscript resolved and numbered 1..n', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const doc = buildBoardPackPages(page6Input(shape));
      assertPackIntegrity(doc);
      const idx = doc.pages.findIndex((p) => p.navLabel === 'Income statement');
      const id = `pack-page-${idx + 1}`;

      const rendered = renderedNumbers(renderToStaticMarkup(createElement(PackPagesView, { document: doc })), id);
      expect(rendered.markers.length, 'the page prints no superscript at all, so nothing is checked').toBeGreaterThan(0);
      expect(rendered.omission, 'the fixture must make the fitter drop footnotes').toHaveLength(1);
      expect(rendered.listed).toEqual(rendered.listed.map((unusedN, i) => i + 1));
      for (const n of rendered.markers) expect(rendered.listed, `superscript ${n}`).toContain(n);
      expect(rendered.markers, 'a superscript points at the omission note').not.toContain(rendered.omission[0]);

      const printed = await printBoardPack(doc, browser);
      expect(printed.sheets).toBe(doc.pages.length);
      // Page 6 only: at R300m page 3 (highlights) runs past the right edge, with or without this fix.
      expect(printed.overflow.filter((o) => o.id === id)).toEqual([]);
      const height = printed.heights[idx]!;
      // 0.2mm is the harness's own rounding (packSheetCount.test.ts).
      expect(height.overMm, `page 6 runs ${height.overMm}mm past its sheet`).toBeLessThanOrEqual(0.2);
    } finally {
      warn.mockRestore();
    }
  }, 300_000);
});
