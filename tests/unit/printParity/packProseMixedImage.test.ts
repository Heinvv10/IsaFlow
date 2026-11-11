/**
 * THE ROUND-3 BLIND REVIEW'S TEXTS IN PRODUCTION'S IMAGE (#1263): SA runs glued to Latin words, digit strings, URLs and
 * prices; marks the faces lack on bases they set (a digit or a Latin letter under a Thai, Khmer or Myanmar mark); Indic
 * prose, which the spacing marks' standalone advance priced half again over what prints. No cell reads short, by the
 * page model or the gate, in the narrative at both of page 4's measures, a disclosure and a matters cell, and swept
 * from 30 to 120mm; page 4 with each at the commentary cap, on the four calibration fixtures, stays inside its sheet and
 * is not refused; page 11 with each marked pattern in every journal description stays inside its sheet. Velo only.
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
import { BLIND_R3_GLUED, BLIND_R3_MARKED, BLIND_R3_PAGE_MARKS, BLIND_R3_SCRIPTS } from '../print/fixtures/blindRound3Texts';
import { repeatedTo } from '../print/fixtures/dictionaryScriptTexts';
import { startGotenberg, type Gotenberg } from './gotenbergParity';
import { inImage } from './inImage';
import { paritySkip } from './paritySkip';
import { inBlock, inMattersCell, shortCells, type Cell } from './proseCells';

const W = PAGE_WIDTH_MM.portrait;
const TEXTS = [...BLIND_R3_MARKED, ...BLIND_R3_SCRIPTS, ...BLIND_R3_GLUED];
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

describe.skipIf(unavailable !== null)(`the round-3 blind review's texts in production's image${unavailable === null ? '' : ` (SKIPPED: ${unavailable})`}`, () => {
  it('no cell is read short, by the page model or the gate, at the pack\'s measures and swept 30 to 120mm', async () => {
    const narrative = inBlock('pack-narrative-body');
    const cells: Cell[] = TEXTS.flatMap(([, pattern]) => [80, 300, 900].flatMap((n) => {
      const t = repeatedTo(pattern, n);
      return [narrative(t, PROSE.narrativeBody, W), narrative(t, PROSE.narrativeBody, ((W - GUTTER_MM) * 2) / 3),
        inBlock('pack-disclosure-body', 'p')(t, PROSE.disclosureBody, 60), inMattersCell(t, PROSE.mattersCell, 52.8)];
    }));
    for (let mm = 30; mm <= 120; mm += 1.13) for (const [, pattern] of TEXTS) cells.push(narrative(repeatedTo(pattern, 150), PROSE.narrativeBody, mm));
    const short = await shortCells(gotenberg!, cells);
    expect(short.slice(0, 20), `${short.length} of ${cells.length} cells read short`).toEqual([]);
  }, 1_800_000);

  it('page 4 with each glued or marked text at the commentary cap: inside its sheet on the four fixtures, never refused', async () => {
    const fixtures = [['liveDemoShortPanels', F.liveDemoShortPanelsInput], ['liveDemo', F.liveDemoInput], ['liveDemoRendered', F.liveDemoRenderedInput],
      ['manyLongNullQuantumMatters', F.manyLongNullQuantumMattersInput]] as const;
    const patterns = [...BLIND_R3_GLUED.map(([, p]) => p), ...BLIND_R3_PAGE_MARKS];
    const packs = patterns.flatMap((pattern) => {
      const body = atTheCap(pattern);
      return fixtures.map(([fixture, input]) => [`${JSON.stringify(pattern.slice(0, 12))} on ${fixture}`, { ...input, commentary: { status: 'approved' as const, body, actions: [] } }] as const);
    });
    expect(await pagesOver(packs, 'found')).toEqual([]);
  }, 1_800_000);

  it('page 11 with each marked pattern in every journal description: inside its sheet', async () => {
    const packs = BLIND_R3_PAGE_MARKS.map((pattern) => [JSON.stringify(pattern), {
      ...denseInput, matters: denseInput.matters.map((m, i) => ({ ...m, issue: `Journal JE-2026-000${61 + i} (recorded well after its entry date): ${repeatedTo(pattern, 400)}` })),
    }] as const);
    expect(await pagesOver(packs, 'allowed')).toEqual([]);
  }, 1_800_000);
});
