/**
 * THE ROUND-7 REVIEWS' TEXTS IN PRODUCTION'S IMAGE (#1264): a digit, "#", "*" or a letter beside a ZWJ and a pictograph,
 * a skin tone on a base that takes none, a text selector after a pictograph (U+1F634 U+FE0E is 19px), skin tones around a
 * joined sequence, a pictograph after a lone modifier or regional indicator, and the keycaps. No cell reads short, by the
 * page model or the gate, in the narrative at both of page 4's measures, a disclosure and the matters' three issue widths;
 * page 4 with each at the commentary cap, on the four calibration fixtures, stays inside its sheet and is not refused;
 * page 11 with each in every journal description of the dense company, at 150 and 400 characters, likewise. And the widths:
 * every Extended_Pictographic code point in fourteen sequence forms (79,744 strings), marks after a deleted character and 60,000 seeded random emoji-class
 * strings are no wider in production than the page model's width, and the gate's bound is no narrower. Velo only.
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
import { textExactPx } from '@/modules/accounting/services/packs/pages/packFigureWidth';
import { boundPx } from '@/modules/accounting/services/packs/pages/packProseBound';
import { PROSE } from '@/modules/accounting/services/packs/pages/packProseStyles';
import { GUTTER_MM, PAGE_WIDTH_MM, PRINT_CONTENT_HEIGHT_PX } from '@/modules/accounting/services/packs/pages/packTextMetrics';
import { denseInput } from '../services/packs/fixtures/boardPackInputs';
import * as F from '../services/packs/fixtures/liveDemoBoardPack';
import { ROUND7_CHAINS, ROUND7_JOINED, ROUND7_KEYCAPS, ROUND7_LONE_MODIFIER, ROUND7_SKIN, ROUND7_SWEEP, ROUND7_TEXT_SELECTOR } from '../print/fixtures/adversaryRound7Texts';
import { repeatedTo } from '../print/fixtures/dictionaryScriptTexts';
import { emojiFuzz, gapTexts, pictographSweep } from './emojiWidthSweep';
import { startGotenberg, type Gotenberg } from './gotenbergParity';
import { inImage } from './inImage';
import { paritySkip } from './paritySkip';
import { inBlock, inMattersCell, shortCells, type Cell } from './proseCells';

const W = PAGE_WIDTH_MM.portrait;
const HEIGHTS_SCRIPT = `function answer() { return Array.from(document.querySelectorAll('.pack-page')).map(function (pg) {
  var top = pg.getBoundingClientRect().top; var bottom = top;
  pg.querySelectorAll('*').forEach(function (e) { var b = e.getBoundingClientRect(); if (b.height > 0) bottom = Math.max(bottom, b.bottom); });
  return 'H|' + (bottom - top).toFixed(2); }); }`;
/**
 * The width sweep's tolerance: the float noise of kerning and mark positioning (a letter with a combining mark: 0.33px in
 * 38), on strings of no emoji class. A string of the class that is read short is short by a glyph (4px and more).
 */
const NOISE_PX = 0.5;

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

/** Each of `texts` set at 12px regular in production, its width. */
async function widthsInImage(texts: readonly string[]): Promise<number[]> {
  const out: number[] = [];
  for (let at = 0; at < texts.length; at += 4_000) {
    const slice = texts.slice(at, at + 4_000);
    const script = `function answer() { var S = ${JSON.stringify(slice)}; var host = document.getElementById('scan'); var els = [];
      S.forEach(function (s) { var d = document.createElement('div'); var sp = document.createElement('span');
        sp.style.cssText = 'font-family:var(--pack-font-sans);font-size:12px;font-weight:400;white-space:pre'; sp.textContent = s; d.appendChild(sp); host.appendChild(d); els.push(sp); });
      return els.map(function (e) { return 'W|' + e.getBoundingClientRect().width.toFixed(4); }); }`;
    const got = (await inImage(gotenberg!, script)).filter((l) => l.startsWith('W|')).map((l) => Number(l.slice(2)));
    if (got.length !== slice.length) throw new Error(`the image's widths came back incomplete: ${got.length} of ${slice.length}`);
    out.push(...got);
  }
  return out;
}

const hex = (text: string): string => Array.from(text, (ch) => ch.codePointAt(0)!.toString(16)).join(' ');

describe.skipIf(unavailable !== null)(`the round-7 adversary's texts in production's image${unavailable === null ? '' : ` (SKIPPED: ${unavailable})`}`, () => {
  const named = [...ROUND7_JOINED, ...ROUND7_SKIN, ...ROUND7_TEXT_SELECTOR, ...ROUND7_CHAINS, ...ROUND7_LONE_MODIFIER, ...ROUND7_KEYCAPS];

  it('no cell is read short, by the page model or the gate, at the pack\'s measures', async () => {
    const narrative = inBlock('pack-narrative-body');
    const everywhere: Cell[] = named.flatMap((pattern) => {
      const t = repeatedTo(pattern, 700);
      return [narrative(t, PROSE.narrativeBody, W), narrative(t, PROSE.narrativeBody, ((W - GUTTER_MM) * 2) / 3),
        inBlock('pack-disclosure-body', 'p')(t, PROSE.disclosureBody, 60), ...[52.8, 67, 90.7].map((mm) => inMattersCell(t, PROSE.mattersCell, mm))];
    });
    const sweep: Cell[] = ROUND7_SWEEP.flatMap((pattern) => {
      const t = repeatedTo(pattern, 700);
      return [narrative(t, PROSE.narrativeBody, W), ...[52.8, 67].map((mm) => inMattersCell(t, PROSE.mattersCell, mm))];
    });
    const short = [...await shortCells(gotenberg!, everywhere)];
    for (let from = 0; from < sweep.length; from += 3_000) short.push(...await shortCells(gotenberg!, sweep.slice(from, from + 3_000)));
    expect(short.slice(0, 20), `${short.length} of ${everywhere.length + sweep.length} cells read short`).toEqual([]);
  }, 3_600_000);

  it('page 4 with each at the commentary cap: inside its sheet on the four fixtures, never refused', async () => {
    const fixtures = [['liveDemoShortPanels', F.liveDemoShortPanelsInput], ['liveDemo', F.liveDemoInput], ['liveDemoRendered', F.liveDemoRenderedInput],
      ['manyLongNullQuantumMatters', F.manyLongNullQuantumMattersInput]] as const;
    const packs = pagePatterns().flatMap((pattern) => {
      const body = atTheCap(pattern);
      return fixtures.map(([fixture, input]) => [`${JSON.stringify(hex(pattern).slice(0, 24))} on ${fixture}`, { ...input, commentary: { status: 'approved' as const, body, actions: [] as string[] } }] as const);
    });
    expect(await pagesOver(packs, 'found')).toEqual([]);
  }, 3_600_000);

  it('page 11 with each in every journal description of the dense company: every page inside its sheet', async () => {
    const packs = pagePatterns().flatMap((pattern) => [150, 400].map((n) => [`${JSON.stringify(hex(pattern).slice(0, 24))} x ${n}`, {
      ...denseInput, matters: denseInput.matters.map((m, i) => ({ ...m, issue: `Journal JE-2026-000${61 + i} (recorded well after its entry date): ${repeatedTo(pattern, n)}` })),
    }] as const));
    // A matter too tall for its page refuses the pack (as on master), which prints nothing past a sheet.
    expect(await pagesOver(packs, 'allowed')).toEqual([]);
  }, 3_600_000);

  it('every pictograph in fourteen sequence forms, marks after a deleted character, and 60,000 seeded random emoji-class strings, are no wider in production than the model and the gate', async () => {
    const texts = [...gapTexts(), ...pictographSweep(), ...emojiFuzz(1, 20_000), ...emojiFuzz(2, 20_000), ...emojiFuzz(3, 20_000)];
    const printed = await widthsInImage(texts);
    const wrong = texts.flatMap((t, i) => {
      const model = textExactPx(t, 12, 400, false, true);
      const bound = boundPx(t, 12);
      return printed[i]! > model + NOISE_PX || printed[i]! > bound + NOISE_PX ? [`${hex(t)}: production ${printed[i]}, model ${model.toFixed(3)}, gate ${bound.toFixed(3)}`] : [];
    });
    expect(wrong.slice(0, 20), `${wrong.length} of ${texts.length} strings are wider in production`).toEqual([]);
  }, 3_600_000);
});

/** The patterns page 4 and page 11 are set with: the report's, and a spread of this round's sweep. */
function pagePatterns(): string[] {
  const every = (list: readonly string[], n: number): string[] => list.filter((_, i) => i % n === 0);
  return [...ROUND7_JOINED.slice(0, 12), ...ROUND7_CHAINS, ...ROUND7_TEXT_SELECTOR, ...every(ROUND7_SKIN, 12), ...every(ROUND7_LONE_MODIFIER, 20), ...ROUND7_KEYCAPS.slice(0, 3)];
}
