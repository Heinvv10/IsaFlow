/**
 * PASTED LINKS AND HYPHENATED FILE NAMES NEVER READ A LINE SHORT, IN PRODUCTION'S IMAGE (#1263 round 1, the adversary's
 * H1). Chromium breaks such a token after its hyphens and slashes and nowhere else, so each line ends short of the
 * measure by what the next piece needed; charged as continuous fill, a SharePoint link in a journal's description read
 * page 11 at 251mm where production set it at 278mm, a thirteenth sheet. `packProseFill` now breaks by
 * `packLineBreaks.pieces` and keeps each piece whole. Held here, on the adversary's own strings
 * (`print/fixtures/proseLinkTexts`), in the cells they reach:
 *  - the matters' issue column at its three widths, and the owner and decision columns at theirs (`overflow-wrap:
 *    normal`), in the table's own markup;
 *  - page 4's commentary across the page and beside the panel (`anywhere`), by the page model and by the gate's bound,
 *    and a disclosure's body;
 *  - and whole packs: the dense company's fifteen journals with each description in turn, every page inside its sheet.
 * Velo only.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { PROSE } from '@/modules/accounting/services/packs/pages/packProseStyles';
import { GUTTER_MM, PAGE_WIDTH_MM, PRINT_CONTENT_HEIGHT_PX } from '@/modules/accounting/services/packs/pages/packTextMetrics';
import { denseInput } from '../services/packs/fixtures/boardPackInputs';
import * as T from '../print/fixtures/proseLinkTexts';
import { startGotenberg, type Gotenberg } from './gotenbergParity';
import { inImage } from './inImage';
import { paritySkip } from './paritySkip';
import { inBlock, inMattersCell, shortCells } from './proseCells';

const issue = (description: string, n = 0): string => `Journal JE-2026-000${String(n + 61).padStart(2, '0')} (recorded well after its entry date): ${description}`;
const W = PAGE_WIDTH_MM.portrait;

/** Each page's content height: from its top to the lowest box drawn on it. */
const HEIGHTS_SCRIPT = `function answer() { return Array.from(document.querySelectorAll('.pack-page')).map(function (pg) {
  var top = pg.getBoundingClientRect().top; var bottom = top;
  pg.querySelectorAll('*').forEach(function (e) { var b = e.getBoundingClientRect(); if (b.height > 0) bottom = Math.max(bottom, b.bottom); });
  return 'H|' + (bottom - top).toFixed(2); }); }`;

const unavailable = paritySkip();
let gotenberg: Gotenberg | undefined;
beforeAll(async () => { if (unavailable === null) gotenberg = await startGotenberg(); }, 180_000);
afterAll(() => { gotenberg?.stop(); });

describe.skipIf(unavailable !== null)(`links and file names in production's image${unavailable === null ? '' : ` (SKIPPED: ${unavailable})`}`, () => {
  it('the matters\' columns: no cell is read short', async () => {
    const issues = [...T.issueTexts(), ...[...T.linkDescriptions(), ...T.chainDescriptions()].map((d) => issue(d)), ...T.punctuationTexts()];
    const narrow = [...T.NARROW_COMPOUNDS, ...T.punctuationTexts()];
    const cells = [
      ...issues.flatMap((t) => [52.8, 67, 90.7].map((mm) => inMattersCell(t, PROSE.mattersCell, mm))),
      ...narrow.flatMap((t) => [24.4, 31.5].map((mm) => inMattersCell(t, PROSE.mattersCell, mm))),
    ];
    const short = await shortCells(gotenberg!, cells);
    expect(short.slice(0, 20), `${short.length} of ${cells.length} cells read short`).toEqual([]);
  }, 1_800_000);

  it('page 4\'s commentary and a disclosure\'s body: neither the page model nor the gate reads a line short', async () => {
    const texts = [...T.commentaryWithLinks(), ...T.punctuationTexts(), ...T.linkDescriptions()];
    const narrative = inBlock('pack-narrative-body');
    const disclosure = inBlock('pack-disclosure-body', 'p');
    const cells = texts.flatMap((t) => [
      narrative(t, PROSE.narrativeBody, W), narrative(t, PROSE.narrativeBody, ((W - GUTTER_MM) * 2) / 3),
      disclosure(t, PROSE.disclosureBody, W),
    ]);
    const short = await shortCells(gotenberg!, cells);
    expect(short.slice(0, 20), `${short.length} of ${cells.length} settings read short`).toEqual([]);
  }, 1_800_000);

  it('the dense company with each description on its fifteen journals: every page inside its sheet', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const over: string[] = [];
    try {
      for (const description of [...T.linkDescriptions(), ...T.chainDescriptions()]) {
        const doc = buildBoardPackPages({ ...denseInput, matters: denseInput.matters.map((m, n) => ({ ...m, issue: issue(description, n) })) });
        const body = renderToStaticMarkup(createElement(PackPagesView, { document: doc }));
        const heights = (await inImage(gotenberg!, HEIGHTS_SCRIPT, body)).filter((l) => l.startsWith('H|')).map((l) => Number(l.slice(2)));
        expect(heights.length, 'the image\'s page heights came back incomplete').toBe(doc.pages.length);
        doc.pages.forEach((p, i) => {
          if (heights[i]! > PRINT_CONTENT_HEIGHT_PX[p.orientation]) over.push(`${JSON.stringify(description).slice(0, 50)}: ${p.navLabel} ${heights[i]}px`);
        });
      }
    } finally {
      warn.mockRestore();
    }
    expect(over, `${over.length} pages past their sheet`).toEqual([]);
  }, 1_800_000);
});
