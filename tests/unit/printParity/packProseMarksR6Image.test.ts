/**
 * THE ROUND-6 REVIEWS' TEXTS IN PRODUCTION'S IMAGE (#1264): a mark after one of the 14 characters the ruler deletes (soft
 * hyphen, zero-width space, word joiner, bidi controls), a variation selector after a base the faces lack (U+022E, U+109E,
 * ...), emoji ZWJ sequences that are not one emoji, and tall mark stacks. No cell reads short, by the page model or the
 * gate, in the narrative at both of page 4's measures, a disclosure and the matters' three issue widths (the 10,542
 * deleted-character cells and the 305 selector cells at the narrative and two matters widths, the sweep's own); page 4
 * with each page pattern at the commentary cap, on the four calibration fixtures, stays inside its sheet and is not
 * refused; page 11 with each in every journal description of the dense company, at 150 and 400 characters, likewise.
 * Velo only.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import { MAX_APPROVED_PACK_EMS, commentaryCost } from '@/modules/accounting/services/commentary/commentaryLimits';
import { PackRefusal } from '@/modules/accounting/services/packs/packRefusal';
import type { StampedPackPagesDocument } from '@/modules/accounting/services/packs/pages/packFigureFitCss';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { PROSE } from '@/modules/accounting/services/packs/pages/packProseStyles';
import { GUTTER_MM, PAGE_WIDTH_MM, PRINT_CONTENT_HEIGHT_PX } from '@/modules/accounting/services/packs/pages/packTextMetrics';
import { denseInput } from '../services/packs/fixtures/boardPackInputs';
import * as F from '../services/packs/fixtures/liveDemoBoardPack';
import { ROUND6_COMMON_EMOJI, ROUND6_EMOJI, ROUND6_IGNORED, ROUND6_NAMED, ROUND6_PAGES, ROUND6_SELECTORS, ROUND6_STACKS } from '../print/fixtures/adversaryRound6Texts';
import { repeatedTo } from '../print/fixtures/dictionaryScriptTexts';
import { startGotenberg, type Gotenberg } from './gotenbergParity';
import { inImage } from './inImage';
import { paritySkip } from './paritySkip';
import { inBlock, inMattersCell, shortCells, type Cell } from './proseCells';

const W = PAGE_WIDTH_MM.portrait;
const HEIGHTS_SCRIPT = `function answer() { return Array.from(document.querySelectorAll('.pack-page')).map(function (pg) {
  var top = pg.getBoundingClientRect().top; var bottom = top;
  pg.querySelectorAll('*').forEach(function (e) { var b = e.getBoundingClientRect(); if (b.height > 0) bottom = Math.max(bottom, b.bottom); });
  return 'H|' + (bottom - top).toFixed(2); }); }`;

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

async function pagesOver(packs: ReadonlyArray<readonly [string, BoardPackInput]>, refusals: 'allowed' | 'found'): Promise<string[]> {
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  const over: string[] = [];
  try {
    for (const [name, input] of packs) {
      let doc;
      try { doc = buildBoardPackPages(input); } catch (err) {
        if (!(err instanceof PackRefusal)) throw err;
        if (refusals === 'found') over.push(`${name}: refused, though the gate admitted it`);
        continue;
      }
      // Unstamped on purpose: the page is set as the composer built it (the type wants the stamp the print adds).
      const body = renderToStaticMarkup(createElement(PackPagesView, { document: doc as unknown as StampedPackPagesDocument }));
      const heights = (await inImage(gotenberg!, HEIGHTS_SCRIPT, body)).filter((l) => l.startsWith('H|')).map((l) => Number(l.slice(2)));
      doc.pages.forEach((p, i) => { if (heights[i]! > PRINT_CONTENT_HEIGHT_PX[p.orientation]) over.push(`${name}: ${p.navLabel} ${heights[i]}px`); });
    }
  } finally {
    warn.mockRestore();
  }
  return over;
}

describe.skipIf(unavailable !== null)(`the round-6 adversary's texts in production's image${unavailable === null ? '' : ` (SKIPPED: ${unavailable})`}`, () => {
  it('no cell is read short, by the page model or the gate, at the pack\'s measures', async () => {
    const narrative = inBlock('pack-narrative-body');
    const everywhere: Cell[] = [...ROUND6_NAMED, ...ROUND6_EMOJI, ...ROUND6_COMMON_EMOJI, ...ROUND6_PAGES, ...ROUND6_STACKS].flatMap((pattern) => {
      const t = repeatedTo(pattern, 700);
      return [narrative(t, PROSE.narrativeBody, W), narrative(t, PROSE.narrativeBody, ((W - GUTTER_MM) * 2) / 3),
        inBlock('pack-disclosure-body', 'p')(t, PROSE.disclosureBody, 60), ...[52.8, 67, 90.7].map((mm) => inMattersCell(t, PROSE.mattersCell, mm))];
    });
    const sweep: Cell[] = [...ROUND6_IGNORED, ...ROUND6_SELECTORS].flatMap((pattern) => {
      const t = repeatedTo(pattern, 700);
      return [narrative(t, PROSE.narrativeBody, W), ...[52.8, 67].map((mm) => inMattersCell(t, PROSE.mattersCell, mm))];
    });
    const short = await shortCells(gotenberg!, everywhere);
    // The sweep is large: a page of cells at a time.
    for (let from = 0; from < sweep.length; from += 3_000) short.push(...await shortCells(gotenberg!, sweep.slice(from, from + 3_000)));
    expect(short.slice(0, 20), `${short.length} of ${everywhere.length + sweep.length} cells read short`).toEqual([]);
  }, 3_600_000);

  it('page 4 with each at the commentary cap: inside its sheet on the four fixtures, never refused', async () => {
    const fixtures = [['liveDemoShortPanels', F.liveDemoShortPanelsInput], ['liveDemo', F.liveDemoInput], ['liveDemoRendered', F.liveDemoRenderedInput],
      ['manyLongNullQuantumMatters', F.manyLongNullQuantumMattersInput]] as const;
    const packs = [...ROUND6_PAGES, ...ROUND6_STACKS, ...ROUND6_COMMON_EMOJI.slice(0, 60)].flatMap((pattern) => {
      const body = atTheCap(pattern);
      return fixtures.map(([fixture, input]) => [`${JSON.stringify(pattern.slice(0, 12))} on ${fixture}`, { ...input, commentary: { status: 'approved' as const, body, actions: [] as string[] } }] as const);
    });
    expect(await pagesOver(packs, 'found')).toEqual([]);
  }, 1_800_000);

  it('page 11 with each in every journal description of the dense company: every page inside its sheet', async () => {
    const packs = [...ROUND6_PAGES, ...ROUND6_COMMON_EMOJI.slice(0, 60)].flatMap((pattern) => [150, 400].map((n) => [`${JSON.stringify(pattern.slice(0, 12))} x ${n}`, {
      ...denseInput, matters: denseInput.matters.map((m, i) => ({ ...m, issue: `Journal JE-2026-000${61 + i} (recorded well after its entry date): ${repeatedTo(pattern, n)}` })),
    }] as const));
    // A matter too tall for its page refuses the pack (as on master), which prints nothing past a sheet.
    expect(await pagesOver(packs, 'allowed')).toEqual([]);
  }, 1_800_000);
});
