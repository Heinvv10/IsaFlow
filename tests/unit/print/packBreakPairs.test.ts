/**
 * THE SPLITTER BREAKS WHERE CHROMIUM BREAKS, BY THE PAIR TABLE (`packBreakPairs.ts`), held in the print tests' Chromium:
 *  - the census: every character the table covers (`printParity/breakPairsDomain.ts`), after a word, a number, a
 *    bracket, a stop, a no-break space, a space or nothing, and before a word, a number, a capital, every opener, every
 *    opening quote, the inverted question mark, a currency sign before a number, a space, a footnote mark's digit or
 *    nothing; and 3,000 random strings of them with spaces, soft hyphens, zero-width spaces and an ideograph. Set at
 *    width 0 (every opportunity taken), the model breaks at exactly Chromium's places, no more and no fewer, but beside
 *    a character the host draws with no width, where no break can be read (`fixtures/breakPairsCensus.readBreaks`);
 *  - every character the table covers with a variation selector 16 after it (read by its base), but for the 13 known;
 *  - the adversary's census of #1235's third round, as line counts at width 0, with and without a mark;
 *  - the min-content of the census strings that break, in the faces: the model's widest piece is never narrower than
 *    Chromium's narrowest width, and at most 1/32px over (`textPx` is never short); a character the faces lack takes
 *    the host's fallback face, which the image holds (`packFallbackWidthData.ts`);
 *  - line counts: as table labels, at widths from min-content up, never a line fewer than Chromium (`holdLines`).
 * The table itself is production's image's (`printParity/packBreakPairsImage.test.ts` re-scans it there, and holds the
 * model to production's Chromium on the whole census); where the two Chromiums differ, production's is held
 * (`fixtures/breakPairsCensus.asProduction`).
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { pieces } from '@/modules/accounting/services/packs/pages/packLineBreaks';
import { labelWidestPiecePx } from '@/modules/accounting/services/packs/pages/packFigureFit';
import { labelLineCount } from '@/modules/accounting/services/packs/pages/packTableLayout';
import { launchPrintChromium } from './printChromium';
import { openProbePage } from './measureWidths';
import { fillCase, holdLines } from './support/lineFitHarness';
import { adversaryCensus, alike, asProduction, BREAKS_OF, CENSUS, heldLines, inFaces, LINES_OF, linesHtml, modelBreaks, randomStrings, readable, readBreaks, VS16_CENSUS, vs16Differences, VS16_RESIDUAL } from './fixtures/breakPairsCensus';

let browser: Browser;
beforeAll(async () => { browser = await launchPrintChromium(); }, 120_000);
afterAll(async () => { await browser?.close(); });

/** The print tests' Chromium's breaks the table decides, as production's (`asProduction`), and where none can be read. */
async function chromiumBreaks(texts: readonly string[]): Promise<Array<{ real: number[]; blind: Set<number> }>> {
  const page = await openProbePage(browser);
  const out: number[][] = [];
  try {
    for (let at = 0; at < texts.length; at += 5000) {
      out.push(...await page.evaluate(`(function () { ${BREAKS_OF}; return breaksOf(${JSON.stringify(texts.slice(at, at + 5000))}); })()`) as number[][]);
    }
  } finally {
    await page.close();
  }
  return out.map((b, i) => { const read = readBreaks(texts[i]!, b); return { real: asProduction(texts[i]!, read.real), blind: read.blind }; });
}

/** Each text where model and Chromium break differently between two characters the faces set, with both. */
async function differences(texts: readonly string[]): Promise<{ wrong: string[]; breaks: number }> {
  const real = await chromiumBreaks(texts);
  let breaks = 0;
  const wrong = texts.flatMap((t, i) => {
    const { real: chromium, blind } = real[i]!;
    const model = modelBreaks(t).filter((b) => !blind.has(b));
    breaks += chromium.length;
    return model.join(',') === chromium.join(',') ? [] : [`${JSON.stringify(t)}: model ${model.join(',')} Chromium ${chromium.join(',')}`];
  });
  return { wrong, breaks };
}

/** One whose widths are the pack's faces' (a character they lack is set from the host's fallback faces: the image's to hold). */
const measurable = (t: string): boolean => alike(t) && inFaces(t);

it(`the census (${CENSUS.length} strings): the model breaks where Chromium breaks, and nowhere else`, async () => {
  expect(CENSUS.length).toBeGreaterThan(80_000);
  const { wrong, breaks } = await differences(CENSUS.filter(readable));
  expect(wrong.slice(0, 20), `${wrong.length} of ${CENSUS.length} differ`).toEqual([]);
  expect(breaks, 'breaks between two of the faces\' characters').toBeGreaterThan(3_000);
}, 900_000);

it('3,000 random strings of the faces\' characters, spaces, soft hyphens, zero-width spaces and an ideograph: the same breaks', async () => {
  const texts = randomStrings(3000).filter(readable);
  const { wrong, breaks } = await differences(texts);
  expect(wrong.slice(0, 20), `${wrong.length} of ${texts.length} differ`).toEqual([]);
  expect(breaks, 'breaks between two of the faces\' characters').toBeGreaterThan(500);
}, 900_000);

it(`every character with a variation selector 16 after it (${VS16_CENSUS.length} strings): the model breaks where Chromium breaks, but for the known`, async () => {
  const texts = VS16_CENSUS.filter(readable);
  const page = await openProbePage(browser);
  const raw: number[][] = [];
  try {
    for (let at = 0; at < texts.length; at += 5000) {
      raw.push(...await page.evaluate(`(function () { ${BREAKS_OF}; return breaksOf(${JSON.stringify(texts.slice(at, at + 5000))}); })()`) as number[][]);
    }
  } finally {
    await page.close();
  }
  const wrong = vs16Differences(texts, raw);
  expect(wrong.filter((t) => !VS16_RESIDUAL.has(t)).map((t) => JSON.stringify(t)).slice(0, 20)).toEqual([]);
  expect(wrong.length).toBe(VS16_RESIDUAL.size);
}, 600_000);

it('the adversary\'s census (#1235 round 3: every character to U+30FF in fifteen contexts, every pair of the faces\' punctuation, with and without a mark): the model\'s lines are Chromium\'s', async () => {
  // Where the two Chromiums differ (a word-opening hyphen before a letter, the braille blank), production's is held, by the image test.
  const items = adversaryCensus().filter(({ text }) => alike(text));
  expect(items.length).toBeGreaterThan(110_000);
  const page = await openProbePage(browser);
  const real: string[] = [];
  try {
    for (let at = 0; at < items.length; at += 4000) {
      const html = items.slice(at, at + 4000).map(({ text, marked }) => linesHtml(text, marked));
      real.push(...await page.evaluate(`(function () { ${LINES_OF}; return linesOf(${JSON.stringify(html)}); })()`) as string[]);
    }
  } finally {
    await page.close();
  }
  const wrong = items.flatMap(({ text, marked }, i) => {
    const { chromium, model } = heldLines(text, marked, real[i]!);
    return model === chromium ? [] : [`${JSON.stringify(text)}${marked ? '^1' : ''}: model ${model} lines, Chromium ${chromium}`];
  });
  expect(wrong.slice(0, 20), `${wrong.length} of ${items.length} differ`).toEqual([]);
}, 1_800_000);

it('the census strings that break, in the faces: their min-content is the model\'s widest piece, never narrower, at most 1/32px over', async () => {
  const texts = CENSUS.filter((t) => measurable(t) && pieces(t).length > 1).filter((unused, i) => i % 7 === 0);
  expect(texts.length).toBeGreaterThan(2000);
  const page = await openProbePage(browser);
  let real: number[];
  try {
    real = await page.evaluate((list) => {
      const host = document.querySelector('.pack-page')!;
      return list.map((t) => {
        const d = document.createElement('div');
        d.style.cssText = 'display:inline-block;width:min-content;white-space:normal;font-size:12px;font-weight:400';
        d.textContent = t; host.appendChild(d);
        const w = d.getBoundingClientRect().width; d.remove(); return w;
      });
    }, texts);
  } finally {
    await page.close();
  }
  const wrong = texts.flatMap((t, i) => {
    const model = labelWidestPiecePx(t, null, 400);
    return model < real[i]! - 1e-6 || model > real[i]! + 2 / 64 + 1e-6 ? [`${JSON.stringify(t)}: model ${model * 64}/64, Chromium ${real[i]! * 64}/64`] : [];
  });
  expect(wrong.slice(0, 20), `${wrong.length} of ${texts.length}`).toEqual([]);
}, 900_000);

it('the census strings that break, in the faces, as table labels: never a line fewer than Chromium at any width from their min-content up', async () => {
  const texts = CENSUS.filter((t) => measurable(t) && pieces(t).length > 1).filter((unused, i) => i % 19 === 0);
  expect(texts.length).toBeGreaterThan(800);
  const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const cases = texts.map((t) => fillCase(`label ${JSON.stringify(t)}`, `<span style="font-size:12px;font-weight:400;white-space:normal">${esc(t)}</span>`, (px) => labelLineCount(t, null, 400, px, 0)));
  const more = await holdLines(browser, cases, 4);
  process.stdout.write(`BREAKPAIRS lines: ${more} widths a line over\n`);
}, 900_000);
