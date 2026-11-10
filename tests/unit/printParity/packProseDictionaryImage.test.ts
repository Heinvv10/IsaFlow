/**
 * THE SCRIPTS CHROMIUM BREAKS BY DICTIONARY PRINT WHERE THE MODEL BREAKS THEM, IN PRODUCTION'S IMAGE (#1263 round 2, the
 * adversary's H1). A Thai, Lao, Myanmar or Khmer run is one piece to the page model, which fills a piece wider than its
 * line grapheme by grapheme; Chromium broke it only between dictionary words, each line short of full, so a Burmese
 * commentary the gate admitted printed page 4 a sheet long. Each such run is now set in a `.pack-dictionary` span
 * (`word-break: break-all`, `PackProse`), and a spacing mark costs its own advance (`packFallbackWidthCore`: at nothing,
 * Burmese read 18% narrow). Held here: the patterns in every prose context the pack sets them in, at 60 to 1,200
 * graphemes; page 4 with each at the commentary cap on the four calibration fixtures, and page 11 with each in every
 * journal description of the dense company: every page inside its sheet. Velo only.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import { MAX_APPROVED_PACK_EMS, commentaryCost } from '@/modules/accounting/services/commentary/commentaryLimits';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { graphemes } from '@/modules/accounting/services/packs/pages/packGraphemes';
import { PROSE } from '@/modules/accounting/services/packs/pages/packProseStyles';
import { GUTTER_MM, PAGE_WIDTH_MM, PRINT_CONTENT_HEIGHT_PX } from '@/modules/accounting/services/packs/pages/packTextMetrics';
import { denseInput } from '../services/packs/fixtures/boardPackInputs';
import * as F from '../services/packs/fixtures/liveDemoBoardPack';
import { DICTIONARY_PATTERNS, repeatedTo } from '../print/fixtures/dictionaryScriptTexts';
import { startGotenberg, type Gotenberg } from './gotenbergParity';
import { inImage } from './inImage';
import { paritySkip } from './paritySkip';
import { inBlock, inMattersCell, shortCells, type Cell } from './proseCells';

const W = PAGE_WIDTH_MM.portrait;
const HEIGHTS_SCRIPT = `function answer() { return Array.from(document.querySelectorAll('.pack-page')).map(function (pg) {
  var top = pg.getBoundingClientRect().top; var bottom = top;
  pg.querySelectorAll('*').forEach(function (e) { var b = e.getBoundingClientRect(); if (b.height > 0) bottom = Math.max(bottom, b.bottom); });
  return 'H|' + (bottom - top).toFixed(2); }); }`;

/** The longest repetition of `pattern` the commentary gate admits. */
function atTheCap(pattern: string): string {
  let lo = 1;
  let hi = 3_900;
  const make = (n: number): string => repeatedTo(pattern, n).trim();
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (commentaryCost([make(mid)]) <= MAX_APPROVED_PACK_EMS) lo = mid; else hi = mid - 1; }
  return make(lo);
}

const unavailable = paritySkip();
let gotenberg: Gotenberg | undefined;
beforeAll(async () => { if (unavailable === null) gotenberg = await startGotenberg(); }, 180_000);
afterAll(() => { gotenberg?.stop(); });

async function pagesOver(packs: ReadonlyArray<readonly [string, BoardPackInput]>): Promise<string[]> {
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  const over: string[] = [];
  try {
    for (const [name, input] of packs) {
      const doc = buildBoardPackPages(input);
      const body = renderToStaticMarkup(createElement(PackPagesView, { document: doc }));
      const heights = (await inImage(gotenberg!, HEIGHTS_SCRIPT, body)).filter((l) => l.startsWith('H|')).map((l) => Number(l.slice(2)));
      if (heights.length !== doc.pages.length) over.push(`${name}: ${heights.length} of ${doc.pages.length} page heights came back`);
      doc.pages.forEach((p, i) => { if (heights[i]! > PRINT_CONTENT_HEIGHT_PX[p.orientation]) over.push(`${name}: ${p.navLabel} ${heights[i]}px`); });
    }
  } finally {
    warn.mockRestore();
  }
  return over;
}

describe.skipIf(unavailable !== null)(`dictionary-broken scripts in production's image${unavailable === null ? '' : ` (SKIPPED: ${unavailable})`}`, () => {
  it('no cell of them is read short, by the page model or the gate, in any prose context', async () => {
    const narrative = inBlock('pack-narrative-body');
    const cells: Cell[] = DICTIONARY_PATTERNS.flatMap(([, pattern]) => [60, 150, 400, 1200].flatMap((n) => {
      const t = repeatedTo(pattern, n);
      const issue = `Journal JE-2026-00061 (recorded well after its entry date): ${t}`;
      return [
        narrative(t, PROSE.narrativeBody, W), narrative(t, PROSE.narrativeBody, ((W - GUTTER_MM) * 2) / 3),
        inBlock('pack-disclosure-body', 'p')(t, PROSE.disclosureBody, W), inBlock('pack-disclosure-body', 'p')(t, PROSE.disclosureBody, 60),
        inBlock('pack-footnote-text', 'span', 'line-height:11pt;')(t, PROSE.footnote, W - 6),
        ...[24.4, 31.5].map((mm) => inMattersCell(t, PROSE.mattersCell, mm)),
        ...[52.8, 67, 90.7].map((mm) => inMattersCell(issue, PROSE.mattersCell, mm)),
      ];
    }));
    const short = await shortCells(gotenberg!, cells);
    expect(short.slice(0, 20), `${short.length} of ${cells.length} cells read short`).toEqual([]);
  }, 1_800_000);

  it('page 4 with each at the commentary cap, on the four calibration fixtures: every page inside its sheet', async () => {
    const fixtures = [['liveDemoShortPanels', F.liveDemoShortPanelsInput], ['liveDemo', F.liveDemoInput], ['liveDemoRendered', F.liveDemoRenderedInput],
      ['manyLongNullQuantumMatters', F.manyLongNullQuantumMattersInput]] as const;
    const packs = DICTIONARY_PATTERNS.flatMap(([name, pattern]) => {
      const body = atTheCap(pattern);
      expect(graphemes(body).length, `${name} at the cap`).toBeGreaterThan(50);
      return fixtures.map(([fixture, input]) => [`${name} on ${fixture}`, { ...input, commentary: { status: 'approved' as const, body, actions: [] } }] as const);
    });
    expect(await pagesOver(packs)).toEqual([]);
  }, 1_800_000);

  it('page 11 with each in every journal description of the dense company: every page inside its sheet', async () => {
    const packs = DICTIONARY_PATTERNS.flatMap(([name, pattern]) => [150, 400].map((n) => [`${name} x ${n}`, {
      ...denseInput, matters: denseInput.matters.map((m, i) => ({ ...m, issue: `Journal JE-2026-000${61 + i} (recorded well after its entry date): ${repeatedTo(pattern, n)}` })),
    }] as const));
    expect(await pagesOver(packs)).toEqual([]);
  }, 1_800_000);
});
