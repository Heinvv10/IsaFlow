/**
 * THE ROUND-8 REVIEWS' TEXTS IN PRODUCTION'S IMAGE (#1264, the em floor of round 9): a mark or symbol the primary face lacks
 * makes Chromium draw later symbols in a fallback face, wider than each is alone (a keycap mark after a letter, dakuten,
 * Arabic harakat, Indic marks, odd symbols; then U+23D0, U+266E, U+25DC ...), across lines and paragraphs; and a ZWNJ between
 * Khmer, Myanmar or Thai consonants. No cell reads short, by the page model or the gate, in the narrative at both of page
 * 4's measures, a disclosure and the matters' three issue widths; page 4 with each at the commentary cap, on the four
 * calibration fixtures, stays inside its sheet and is not refused; page 11 with each in every journal description of the dense
 * company, at 150 and 400 characters, likewise; and a seeded random sweep (random fallback prefixes, random symbol and letter
 * suffixes, across lines and paragraphs) reads none short. Velo only.
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
import { ROUND8_CELLS, ROUND8_STATE, ROUND8_ZWNJ, stateTextTo, type StateText } from '../print/fixtures/adversaryRound8Texts';
import { repeatedTo } from '../print/fixtures/dictionaryScriptTexts';
import { randomStateTexts } from './stateSweep';
import { startGotenberg, type Gotenberg } from './gotenbergParity';
import { inImage } from './inImage';
import { paritySkip } from './paritySkip';
import { inBlock, inMattersCell, shortCells, type Cell } from './proseCells';

const W = PAGE_WIDTH_MM.portrait;
const HEIGHTS_SCRIPT = `function answer() { return Array.from(document.querySelectorAll('.pack-page')).map(function (pg) {
  var top = pg.getBoundingClientRect().top; var bottom = top;
  pg.querySelectorAll('*').forEach(function (e) { var b = e.getBoundingClientRect(); if (b.height > 0) bottom = Math.max(bottom, b.bottom); });
  return 'H|' + (bottom - top).toFixed(2); }); }`;

/** The longest text of `make(n)` (n graphemes) the commentary gate admits: page 4 is then set as full as the gate lets it. */
function atTheCap(make: (n: number) => string): string {
  let lo = 1;
  let hi = 3_900;
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

const hex = (text: string): string => Array.from(text, (ch) => ch.codePointAt(0)!.toString(16)).join(' ');

/** The texts page 4 and page 11 are set with: the report's cells, a spread of the state sweep, and the ZWNJ runs. */
function pageTexts(): Array<[string, (n: number) => string]> {
  const every = (list: readonly StateText[], n: number): StateText[] => list.filter((_, i) => i % n === 0);
  return [
    ...[...ROUND8_CELLS, ...every(ROUND8_STATE, 23)].map((p): [string, (n: number) => string] => [`${JSON.stringify(hex(p.prefix))}+${hex(p.probe)}${p.sep === ' ' ? '' : ' after a break'}`, (n) => stateTextTo(p, n)]),
    ...ROUND8_ZWNJ.map((pattern): [string, (n: number) => string] => [JSON.stringify(hex(pattern).slice(0, 24)), (n) => repeatedTo(pattern, n).trim()]),
  ];
}

describe.skipIf(unavailable !== null)(`the round-8 adversary's texts in production's image${unavailable === null ? '' : ` (SKIPPED: ${unavailable})`}`, () => {
  it('no cell is read short, by the page model or the gate, at the pack\'s measures', async () => {
    const narrative = inBlock('pack-narrative-body');
    const texts = [...ROUND8_CELLS, ...ROUND8_STATE].map((p) => stateTextTo(p, 700)).concat(ROUND8_ZWNJ.map((pattern) => repeatedTo(pattern, 700)));
    const cells: Cell[] = texts.flatMap((t) => [narrative(t, PROSE.narrativeBody, W), narrative(t, PROSE.narrativeBody, ((W - GUTTER_MM) * 2) / 3),
      inBlock('pack-disclosure-body', 'p')(t, PROSE.disclosureBody, 60), ...[52.8, 67, 90.7].map((mm) => inMattersCell(t, PROSE.mattersCell, mm))]);
    const short: string[] = [];
    for (let from = 0; from < cells.length; from += 3_000) short.push(...await shortCells(gotenberg!, cells.slice(from, from + 3_000)));
    expect(short.slice(0, 20), `${short.length} of ${cells.length} cells read short`).toEqual([]);
  }, 3_600_000);

  it('page 4 with each at the commentary cap: inside its sheet on the four fixtures, never refused', async () => {
    const fixtures = [['liveDemoShortPanels', F.liveDemoShortPanelsInput], ['liveDemo', F.liveDemoInput], ['liveDemoRendered', F.liveDemoRenderedInput],
      ['manyLongNullQuantumMatters', F.manyLongNullQuantumMattersInput]] as const;
    const packs = pageTexts().flatMap(([label, make]) => {
      const body = atTheCap(make);
      return fixtures.map(([fixture, input]) => [`${label} on ${fixture}`, { ...input, commentary: { status: 'approved' as const, body, actions: [] as string[] } }] as const);
    });
    expect(await pagesOver(packs, 'found')).toEqual([]);
  }, 3_600_000);

  it('page 11 with each in every journal description of the dense company: every page inside its sheet', async () => {
    const packs = pageTexts().flatMap(([label, make]) => [150, 400].map((n) => [`${label} x ${n}`, {
      ...denseInput, matters: denseInput.matters.map((m, i) => ({ ...m, issue: `Journal JE-2026-000${61 + i} (recorded well after its entry date): ${make(n)}` })),
    }] as const));
    // A matter too tall for its page refuses the pack (as on master), which prints nothing past a sheet.
    expect(await pagesOver(packs, 'allowed')).toEqual([]);
  }, 3_600_000);

  it('a seeded sweep of random fallback prefixes and random symbol and letter suffixes, across lines and paragraphs, reads none short', async () => {
    const narrative = inBlock('pack-narrative-body');
    const texts = randomStateTexts(1, 1_500);
    const cells: Cell[] = texts.flatMap((t) => [narrative(t, PROSE.narrativeBody, W), inMattersCell(t, PROSE.mattersCell, 52.8)]);
    const short: string[] = [];
    for (let from = 0; from < cells.length; from += 3_000) short.push(...await shortCells(gotenberg!, cells.slice(from, from + 3_000)));
    expect(short.slice(0, 20), `${short.length} of ${cells.length} cells read short`).toEqual([]);
  }, 3_600_000);
});
