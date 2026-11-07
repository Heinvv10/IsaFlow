/**
 * THE PRINT TESTS' CHROMIUM LAYS A PACK OUT EXACTLY AS PRODUCTION'S GOTENBERG DOES.
 *
 * Every pack print test, and every width the fit model was measured from, runs in Playwright's Chromium
 * (`launchPrintChromium`); production prints in Gotenberg's. This sends the same documents to both and fails on any
 * difference in the box of any element or the lines of any text node (`parityPage.ts`):
 *  - every code point the pack's self-hosted faces cover (`selfHostedCodePoints`, read from the woff2 files the
 *    stylesheet loads), set in a KPI tile's not-meaningful reason and in a 9pt table label at the three weights the
 *    pack uses, and the figure characters at every whole size from 6 to 40px at those weights and in a KPI figure;
 *  - NOT the code points outside those faces (`FALLBACK_OWNER`): Chromium sets them in the render host's fallback
 *    fonts, and the image's font set is not velo's or GitHub's (49.9k of them differ, measured 2026-11-07). They are
 *    owned by the width tables measured in the production image, behind the render-time fingerprint guard;
 *  - the packs of the fitter grid (`page6Shapes.allPage6Shapes` x budget x prior x trend panels, 30,720 inputs): every
 *    64th by default, all of them with PARITY_GRID=full;
 *  - AS PRINTED (`pdfParity.ts`): every 128th pack of the grid printed to PDF by both, compared sheet by sheet, word by
 *    word with its box: the sheet count, the page breaks, where each footnote lands, the landscape sheets, and the text
 *    the stylesheet sizes from `100cqw` at the real print width. Every served face must load in both, or it fails.
 * RE-RUN THIS whenever the gotenberg image or the pack's fonts change (`paritySkip.ts` says where it may skip).
 * Gotenberg is a throwaway container of the image production runs (`gotenbergParity.ts`), so this runs on velo only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { log } from '@/lib/logger';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import { PackRefusal } from '@/modules/accounting/services/packs/packRefusal';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { input, type Shape } from '../services/packs/fixtures/page6Grid';
import { allPage6Shapes } from '../services/packs/fixtures/page6Shapes';
import { launchPrintChromium } from '../print/printChromium';
import { gotenbergReport, playwrightReport, startGotenberg, type Gotenberg } from './gotenbergParity';
import { paritySkip } from './paritySkip';
import { printBoth, sheetDifferences } from './pdfParity';
import { FALLBACK_OWNER, inTableCell, parityDocument, parseReport, selfHostedCodePoints } from './parityPage';

const unavailable = paritySkip();
let gotenberg: Gotenberg | undefined;
let browser: Browser | undefined;
beforeAll(async () => {
  if (unavailable !== null) return;
  browser = await launchPrintChromium();
  gotenberg = await startGotenberg();
}, 180_000);
afterAll(async () => {
  await browser?.close();
  gotenberg?.stop();
});

/** The units of `bodies` that the two engines lay out differently, after both have laid out all of them. */
async function differences(bodies: readonly string[]): Promise<string[]> {
  const { html, fonts } = parityDocument(bodies.join(''));
  const [prod, test] = await Promise.all([gotenbergReport(gotenberg!, html, fonts), playwrightReport(browser!, html, fonts)]);
  const a = parseReport(prod);
  const b = parseReport(test);
  if (a.size !== bodies.length || b.size !== bodies.length) return [`reported ${a.size} and ${b.size} of ${bodies.length} units`];
  return [...a].filter(([id, v]) => b.get(id) !== v).map(([id, v]) => `${id}: Gotenberg ${v}, Playwright ${b.get(id)}`);
}

const escape = (ch: string): string => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch);
const glyph = (cp: number): string => (cp >= 0xd800 && cp <= 0xdfff ? '' : escape(String.fromCodePoint(cp)));

/** One unit per code point, each between two bars, wrapped by `wrap`. */
const glyphUnits = (id: string, cps: readonly number[], cellStyle: string, wrap: (text: string) => string): string[] => cps
  .map((cp) => inTableCell(`${id}:${cp.toString(16)}`, cellStyle, `<div>${wrap(`|${glyph(cp)}|`)}</div>`));

const GLYPH_STYLES: ReadonlyArray<readonly [string, string, (t: string) => string]> = [
  ['reason', '', (t) => `<span class="pack-kpi-unavailable">${t}</span>`],
  ['label400', 'font-weight:400', (t) => `<span>${t}</span>`],
  ['label500', 'font-weight:500', (t) => `<span>${t}</span>`],
  ['label600', 'font-weight:600', (t) => `<span>${t}</span>`],
];
/** The fitter grid: page 6's 2,560 shapes x budget x prior x the three trend series (30,720 inputs). */
const GRID: Shape[] = allPage6Shapes().flatMap((shape) => [true, false].flatMap((budget) => [true, false].flatMap((prior) => (['demo', 'none', 'zero'] as const)
  .map((tr) => ({ ...shape, budget, prior, tr })))));

const FIGURE_CHARS = [...'0123456789 ()+-./%<,:–−×abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ '];

describe.skipIf(unavailable !== null)(`Playwright and production's Gotenberg${unavailable === null ? '' : ` (SKIPPED: ${unavailable})`}`, () => {
  it('every code point of the self-hosted faces, in the reason and at each label weight, and the figure characters at every size: the same boxes', async () => {
    const cps = selfHostedCodePoints();
    expect(cps.length, 'the faces cover the pack\'s Latin, Greek and Cyrillic').toBeGreaterThan(800);
    const wrong: string[] = [];
    for (const [id, style, wrap] of GLYPH_STYLES) wrong.push(...await differences(glyphUnits(id, cps, style, wrap)));
    const figures = [400, 500, 600].flatMap((weight) => Array.from({ length: 35 }, (unused, i) => i + 6).map((px) => inTableCell(
      `figure${weight}:${px}`, `font-size:${px}px;font-weight:${weight}`, FIGURE_CHARS.map((c) => `<div><span>|${escape(c)}|</span></div>`).join(''))));
    const kpi = `<div class="pack-pages"><div class="pack-page" data-parity="kpi">${FIGURE_CHARS.map((c) => `<div><span class="pack-kpi-value">|${escape(c)}|</span></div>`).join('')}</div></div>`;
    wrong.push(...await differences([...figures, kpi]));
    expect(wrong.slice(0, 20)).toEqual([]);
  }, 600_000);

  it('names the code points outside the self-hosted faces, U+0020 to U+1FFFF, and their owner', () => {
    const covered = new Set(selfHostedCodePoints());
    const ranges: Array<[number, number]> = [];
    for (let cp = 0x20; cp < 0x20000; cp += 1) {
      if (covered.has(cp) || (cp >= 0xd800 && cp <= 0xdfff)) continue;
      const last = ranges[ranges.length - 1];
      if (last !== undefined && last[1] === cp - 1) last[1] = cp; else ranges.push([cp, cp]);
    }
    log.info('print parity: fallback ranges', { owner: FALLBACK_OWNER, ranges: ranges.map(([a, b]) => `U+${a.toString(16)}-U+${b.toString(16)}`) });
    expect(ranges.some(([a, b]) => a <= 0x4e00 && 0x4e00 <= b), 'CJK is a fallback range').toBe(true);
    expect(ranges.some(([a, b]) => a <= 0x41 && 0x41 <= b), 'Latin is the pack\'s own face').toBe(false);
  });

  it(`the packs of the fitter grid (${process.env.PARITY_GRID === 'full' ? 'all 30,720 inputs' : 'every 64th input'}): the same boxes`, async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const step = process.env.PARITY_GRID === 'full' ? 1 : 64;
    const shapes = GRID;
    const wrong: string[] = [];
    let printed = 0;
    let batch: string[] = [];
    const pending: Array<Promise<string[]>> = [];
    for (let i = 0; i < shapes.length; i += step) {
      let doc;
      try { doc = buildBoardPackPages(input(shapes[i]!)); } catch (e) { if (e instanceof PackRefusal) continue; throw e; }
      batch.push(`<div data-parity="input${i}">${renderToStaticMarkup(createElement(PackPagesView, { document: doc }))}</div>`);
      printed += 1;
      if (batch.length === 24) { pending.push(differences(batch)); batch = []; }
      if (pending.length === 4) wrong.push(...(await pending.shift()!));
    }
    if (batch.length > 0) pending.push(differences(batch));
    for (const p of pending) wrong.push(...(await p));
    expect(printed).toBeGreaterThan(step === 1 ? 10_000 : 150);
    expect(wrong.slice(0, 20)).toEqual([]);
  }, 14_400_000);

  it('every 128th pack of the grid, printed to PDF by both: the same sheets, every word in the same box', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const wrong: string[] = [];
    let packs = 0;
    let landscapeSheets = 0;
    for (let i = 0; i < GRID.length; i += 128) {
      let doc;
      try { doc = buildBoardPackPages(input(GRID[i]!)); } catch (e) { if (e instanceof PackRefusal) continue; throw e; }
      // A board pack composes its pages portrait; every fourth is printed again with page 10 (the trend panels) on a
      // landscape sheet, so the landscape page box, its break and its text are compared too. (Not every page landscape:
      // portrait pages forced onto landscape sheets overflow them, and the two engines fragment overflowing content
      // differently, Chromium 151 against 145; a pack the gates pass never overflows its sheet.)
      const variants = (i / 128) % 4 === 0
        ? [doc, { ...doc, pages: doc.pages.map((page, n) => (n === 9 ? { ...page, orientation: 'landscape' as const } : page)) }] : [doc];
      for (const variant of variants) {
        const printed = await printBoth(gotenberg!, browser!, renderToStaticMarkup(createElement(PackPagesView, { document: variant })));
        packs += 1;
        landscapeSheets += printed.gotenberg.filter((sheet) => /^width="841/.test(sheet)).length;
        wrong.push(...sheetDifferences(printed.gotenberg, printed.playwright).map((w) => `input ${i}${variant === doc ? '' : ' (landscape)'}: ${w}`));
      }
    }
    expect(packs).toBeGreaterThan(150);
    expect(landscapeSheets, 'no landscape sheet was compared').toBeGreaterThan(0);
    expect(wrong.slice(0, 20)).toEqual([]);
  }, 3_600_000);
});
