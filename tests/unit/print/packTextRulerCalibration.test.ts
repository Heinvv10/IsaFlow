/**
 * HOW FAR OFF THE PACK'S TEXT RULER IS, ON THE PACK'S OWN SENTENCES — AND
 * WHETHER `WIDTH_SAFETY` COVERS IT.
 *
 * `packTextMetrics` decides how many lines a string takes and every page
 * budget is built on it, under one contract: it may read long and may never
 * read short. `packTextMetrics.test.ts` asserts that contract in LINES, on one
 * and two-line samples. This asserts it in WIDTH, on the paragraphs the pack
 * actually prints — which is where a small systematic optimism turns into a
 * whole line.
 *
 * IT USED TO PIN THE BREACH RATHER THAN CLOSE IT. The em table reads real
 * pack prose short — a lowercase letter of this face averages 0.53em and the
 * table charges 0.47 — and `WIDTH_SAFETY` was 1.08, INSIDE that error rather
 * than above it. This file recorded the six ratios and asserted that the
 * breach still existed, because closing it costs the reader paper and that
 * was not a test's decision to take. It has been taken: task 36 measured
 * every string the ten print fixtures put on paper, at every size the pack
 * wraps prose at, and raised the factor to 1.12 — above the worst of them.
 *
 * SO THE ASSERTION IS NOW THE CONTRACT ITSELF, from both sides:
 *
 *   - no sentence needs more safety than `WIDTH_SAFETY` gives it. This is the
 *     never-under-estimates contract, measured in width. It goes red the day
 *     the em table, the face, or the type scale gets worse.
 *   - the worst still needs more than `FLOOR`. If someone corrects the em
 *     table itself, every ratio drops toward 1.0, this goes red, and whoever
 *     did it lowers `WIDTH_SAFETY` and hands the pages back the prose the
 *     factor is currently buying. A safety factor nothing needs is paid for
 *     out of the reader's document.
 *
 * The sentences are measured at 9.5pt, the size the pack sets disclosure
 * notes at and the size whose error is worst. The 11pt measure — disclosure
 * HEADINGS and the definitions' group names — reads worse still and is not
 * covered by 1.12; see `WIDTH_SAFETY`'s own docblock for why that cannot cost
 * a line break today, and `HEADINGS` below, which is what would notice if it
 * ever could.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { textWidthEms, WIDTH_SAFETY } from '@/modules/accounting/services/packs/pages/packTextMetrics';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import {
  brightsphereInput,
  brightsphereLiveInput,
  demoInput,
  denseInput,
  noRatioPanelsInput,
} from '../services/packs/fixtures/boardPackInputs';
import {
  liveDemoBridgeInput,
  liveDemoInput,
  manyLongNullQuantumMattersInput,
  manyShortNullQuantumMattersInput,
  millionsCashInput,
} from '../services/packs/fixtures/liveDemoBoardPack';

/** Every disclosure heading the fixtures put on paper — the strings set at
 *  11pt, which is the measure `WIDTH_SAFETY` does not cover. */
function packHeadings(): string[] {
  const inputs = [
    demoInput, brightsphereInput, denseInput, noRatioPanelsInput, liveDemoInput,
    manyLongNullQuantumMattersInput, manyShortNullQuantumMattersInput, millionsCashInput,
    brightsphereLiveInput, liveDemoBridgeInput,
  ];
  const headings = new Set<string>();
  for (const input of inputs) {
    for (const page of buildBoardPackPages(input).pages) {
      for (const block of page.blocks) {
        if (block.kind === 'disclosure') headings.add(block.disclosure.heading);
      }
    }
  }
  return [...headings];
}

const ROOT = path.resolve(__dirname, '../../..');
const HOST = 'http://ruler.calibration.local/';
const PT = 9.5;

/** Sentences this pack prints, taken from the services that build them. */
const SENTENCES: Array<[string, string]> = [
  ['cash, why no bridge is drawn', 'Cash moved (267) to (3 453) over the period, a movement of (3 186). No bridge is drawn because there is nothing to bridge THROUGH: this pack’s figure set carries the period’s cash totals and none of the operating, investing or financing figures a cash flow statement is made of, so every step between the two balances would be one unmeasured step the width of the whole movement. Ask for the cash flow statement for the split.'],
  ['the rounding note', 'Figures are rounded to the nearest R’000, so components may not add exactly to the totals shown.'],
  ['the inventory caveat', 'No account in the chart of accounts is classified as inventory, so inventory could not be identified and the quick ratio does not exclude it: on these figures the quick ratio and the current ratio are the same number.'],
  ['the debtor-days definition', 'Trade receivables over revenue, times 365 — an annualised figure on the scorecard and highlights, whatever the length of the reporting period.'],
  ['the scoring-basis pointer', 'Each metric is scored against the platform’s default target. The basis page defines the terms and every formula used here.'],
  ['the trends scale note', 'Revenue, Operating expenses, Net profit and Cash share one y-scale, so none of them can look like it moved more than it did.'],
  // THE WORST OF THE 344 STRINGS THE TEN FIXTURES PRINT, and the one the
  // constant is set from. Short, and every letter of it is one the table
  // under-charges; the six above are long enough for the wide characters to
  // dilute the error.
  ['the widest-reading tile caption', 'Operating expenses moved the most, up 101.4%.'],
  // The worst LONG one — a whole paragraph, so the shortfall is the table's
  // and not a rounding artefact of a short string.
  ['the untracked-movement note', 'No prior board pack is stored, so movement since the last meeting is stated as untracked rather than as nil.'],
];

/**
 * Headings, set at 11pt across the full measure. Not asserted against
 * `WIDTH_SAFETY` — they are not covered by it — but asserted to be too SHORT
 * to wrap, which is the reason they need not be. A heading that grows past
 * this makes the 11pt shortfall reachable.
 */
const HEADINGS_MAX_EMS = 30;

/**
 * The floor the worst ratio must stay above. Below it, `WIDTH_SAFETY` is
 * buying more paper than the em table's error needs and the pages are paying
 * for it — see the docblock.
 */
const FLOOR = 1.05;

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 120_000);
afterAll(async () => { await browser?.close(); });

describe('the pack text ruler, measured in width rather than in lines', () => {
  it('reads real pack prose short, by a known and bounded amount', async () => {
    const pack = readFileSync(path.join(ROOT, 'styles/packPrint.css'), 'utf8');
    const html = '<!doctype html><html class="print-mode"><head><meta charset="utf-8"><style>'
      + `body{margin:0;font-family:'IBM Plex Sans',sans-serif}${pack}`
      + `.probe{font-size:${PT}pt;white-space:pre;display:inline-block}</style></head><body>`
      + SENTENCES.map(([, text], i) =>
        `<span class="probe" id="s${i}">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</span>`).join('')
      + '</body></html>';
    const page = await browser.newPage();
    // The real faces, served from `public/fonts` — a fallback face has
    // different advances and would calibrate against the wrong document.
    await page.route(`${HOST}**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({ body: html, contentType: 'text/html' });
      try {
        return await route.fulfill({
          body: readFileSync(path.join(ROOT, 'public', url.pathname)),
          contentType: 'font/woff2',
        });
      } catch {
        return route.fulfill({ status: 404, body: '' });
      }
    });
    await page.goto(HOST);
    await page.evaluate(() => (document as unknown as { fonts: { ready: Promise<void> } }).fonts.ready);
    const px = await page.evaluate((n: number) => Array.from({ length: n }, (_, i) =>
      (document.getElementById(`s${i}`) as HTMLElement).getBoundingClientRect().width), SENTENCES.length);
    await page.close();

    const fontPx = PT * (96 / 72);
    const report = SENTENCES.map(([name, text], i) => {
      const needed = (px[i]! / fontPx) / textWidthEms(text);
      return { name, needed };
    });
    const lines = report.map((r) => `${r.name}: needs ${r.needed.toFixed(3)}`).join('\n  ');

    for (const { name, needed } of report) {
      // THE CONTRACT: the factor covers the error, on every sentence.
      expect(needed, `${name} needs more safety than WIDTH_SAFETY (${WIDTH_SAFETY}) gives it — `
        + `the ruler under-reads this sentence, which is the direction that puts a page on a `
        + `second sheet\n  ${lines}`)
        .toBeLessThanOrEqual(WIDTH_SAFETY);
    }

    // AND THE OTHER SIDE: a factor nothing needs is paid out of the document.
    const worst = Math.max(...report.map((r) => r.needed));
    expect(worst, `the em table no longer under-reads by much (worst ${worst.toFixed(3)}): `
      + `WIDTH_SAFETY of ${WIDTH_SAFETY} is now buying paper the model does not need, and the `
      + `pages it trims are paying for it. Lower it to just above the worst here.\n  ${lines}`)
      .toBeGreaterThan(FLOOR);

    // AND THE ONE MEASURE 1.12 DOES NOT COVER stays out of reach. Every
    // heading the pack sets at 11pt is short enough that it cannot wrap, so
    // the 11pt shortfall cannot cost a line break. This is the assertion that
    // notices when one grows.
    const longHeadings = packHeadings()
      .map((text) => ({ text, ems: textWidthEms(text) }))
      .filter((h) => h.ems > HEADINGS_MAX_EMS);
    expect(longHeadings.map((h) => `${h.text} (${h.ems.toFixed(1)} ems)`),
      'a disclosure heading is now long enough to wrap, and 11pt is the measure WIDTH_SAFETY '
      + 'does not cover — see its docblock')
      .toEqual([]);
  }, 300_000);
});
