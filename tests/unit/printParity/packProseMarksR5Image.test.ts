/**
 * THE ROUND-5 REVIEWS' TEXTS IN PRODUCTION'S IMAGE (#1263): a joiner, selector or format character between a base and its
 * mark (Khmer, Myanmar, Indic: a stray ZWJ or ZWNJ before a vowel sign or a nukta), Lao and Odia marks the table reads at
 * nothing, three or more marks on one base, two or more variation selectors, Ethiopic gemination marks. No cell reads
 * short, by the page model or the gate, in the narrative at both of page 4's measures, a disclosure and the matters'
 * three issue widths; page 4 with each page pattern at the commentary cap, on the four calibration fixtures, stays inside
 * its sheet and is not refused; page 11 with each in every journal description of the dense company likewise. Velo only.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import { MAX_APPROVED_PACK_EMS, commentaryCost } from '@/modules/accounting/services/commentary/commentaryLimits';
import { PackRefusal } from '@/modules/accounting/services/packs/packRefusal';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { PROSE } from '@/modules/accounting/services/packs/pages/packProseStyles';
import { GUTTER_MM, PAGE_WIDTH_MM, PRINT_CONTENT_HEIGHT_PX } from '@/modules/accounting/services/packs/pages/packTextMetrics';
import { denseInput } from '../services/packs/fixtures/boardPackInputs';
import * as F from '../services/packs/fixtures/liveDemoBoardPack';
import { ROUND5_CELLS, ROUND5_MATTERS, ROUND5_PAGES } from '../print/fixtures/adversaryRound5Texts';
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
      const body = renderToStaticMarkup(createElement(PackPagesView, { document: doc }));
      const heights = (await inImage(gotenberg!, HEIGHTS_SCRIPT, body)).filter((l) => l.startsWith('H|')).map((l) => Number(l.slice(2)));
      doc.pages.forEach((p, i) => { if (heights[i]! > PRINT_CONTENT_HEIGHT_PX[p.orientation]) over.push(`${name}: ${p.navLabel} ${heights[i]}px`); });
    }
  } finally {
    warn.mockRestore();
  }
  return over;
}

describe.skipIf(unavailable !== null)(`the round-5 adversary's texts in production's image${unavailable === null ? '' : ` (SKIPPED: ${unavailable})`}`, () => {
  it('no cell is read short, by the page model or the gate, at the pack\'s measures', async () => {
    const narrative = inBlock('pack-narrative-body');
    const cells: Cell[] = ROUND5_CELLS.flatMap((pattern) => {
      const t = repeatedTo(pattern, 700);
      return [narrative(t, PROSE.narrativeBody, W), narrative(t, PROSE.narrativeBody, ((W - GUTTER_MM) * 2) / 3),
        inBlock('pack-disclosure-body', 'p')(t, PROSE.disclosureBody, 60), ...[52.8, 67, 90.7].map((mm) => inMattersCell(t, PROSE.mattersCell, mm))];
    });
    const short = await shortCells(gotenberg!, cells);
    expect(short.slice(0, 20), `${short.length} of ${cells.length} cells read short`).toEqual([]);
  }, 1_800_000);

  it('page 4 with each at the commentary cap: inside its sheet on the four fixtures, never refused', async () => {
    const fixtures = [['liveDemoShortPanels', F.liveDemoShortPanelsInput], ['liveDemo', F.liveDemoInput], ['liveDemoRendered', F.liveDemoRenderedInput],
      ['manyLongNullQuantumMatters', F.manyLongNullQuantumMattersInput]] as const;
    const packs = ROUND5_PAGES.flatMap((pattern) => {
      const body = atTheCap(pattern);
      return fixtures.map(([fixture, input]) => [`${JSON.stringify(pattern.slice(0, 12))} on ${fixture}`, { ...input, commentary: { status: 'approved' as const, body, actions: [] } }] as const);
    });
    expect(await pagesOver(packs, 'found')).toEqual([]);
  }, 1_800_000);

  it('page 11 with each in every journal description of the dense company: every page inside its sheet', async () => {
    const packs = [...ROUND5_MATTERS, ...ROUND5_PAGES].flatMap((pattern) => [150, 400].map((n) => [`${JSON.stringify(pattern.slice(0, 12))} x ${n}`, {
      ...denseInput, matters: denseInput.matters.map((m, i) => ({ ...m, issue: `Journal JE-2026-000${61 + i} (recorded well after its entry date): ${repeatedTo(pattern, n)}` })),
    }] as const));
    // A matter too tall for its page refuses the pack (as on master), which prints nothing past a sheet.
    expect(await pagesOver(packs, 'allowed')).toEqual([]);
  }, 1_800_000);
});
