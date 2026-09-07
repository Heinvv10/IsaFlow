/**
 * HOW FAR OFF THE PACK'S TEXT RULER ACTUALLY IS, ON THE PACK'S OWN SENTENCES.
 *
 * `packTextMetrics` decides how many lines a string takes and every page
 * budget is built on it, under one contract: it may read long and may never
 * read short. `packTextMetrics.test.ts` asserts that contract in LINES, on one
 * and two-line samples. This asserts it in WIDTH, on the four and five-line
 * paragraphs the pack actually prints — which is where a small systematic
 * optimism turns into a whole line.
 *
 * It exists because the contract was being breached and nothing could see it.
 * Brightsphere's sheet 8 budgets 195.6mm and Chromium lays out 198.8mm; the
 * page carrying the difference is one disclosure whose sentence quotes three
 * cash figures, and at that company's scale each formats with a thousands
 * separator — four more characters across the paragraph, which is enough to
 * tip a greedy fill from four lines to five. `millionsCashInput` in
 * `packSheetCount.test.ts` is that page.
 *
 * The cause is not the cash page. The em table reads real pack prose 7.3% to
 * 9.8% short, and `WIDTH_SAFETY` is 1.08 — inside that range rather than above
 * it, so it is a calibration constant and not the safety margin it is
 * documented as. Four of the six sentences below need more than 1.08.
 *
 * WHY THIS PINS THE ERROR RATHER THAN FIXING IT. Raising the constant to 1.10
 * makes every fixture in the suite green and costs the LIVE Brightsphere pack
 * four of its eight basis-of-preparation facts, because page 12 has 1.8mm of
 * headroom and a blanket two per cent is bought out of the reader's document.
 * The correction and the thirteenth sheet are one decision and it is not a
 * test's to take. What a test CAN do is make the size of the error a number
 * someone has to look at, and go red the day it gets worse.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { textWidthEms } from '@/modules/accounting/services/packs/pages/packTextMetrics';

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
];

/**
 * The worst ratio measured, plus a little. The band is asserted from BOTH
 * sides: a table that quietly got worse is the regression, and a table that
 * got better should make someone delete this file and raise the contract.
 */
const WORST_OBSERVED = 1.098;

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
      // The direction that matters: the table must not get worse than what is
      // recorded in `WIDTH_SAFETY`'s docblock and acted on in the fix report.
      expect(needed, `${name} now needs a wider safety than the recorded worst case\n  ${lines}`)
        .toBeLessThanOrEqual(WORST_OBSERVED);
    }

    // AND THE BREACH IS ASSERTED TO STILL EXIST, so this file cannot outlive
    // it silently. When the em table is corrected every ratio drops under
    // 1.08, this goes red, and whoever fixed it deletes the file and tightens
    // `packSheetCount.test.ts`'s named exclusion for sheet 8 with it.
    const worst = Math.max(...report.map((r) => r.needed));
    expect(worst, `the ruler no longer under-reads: WIDTH_SAFETY of 1.08 now covers every `
      + `sentence (worst ${worst.toFixed(3)}). Delete this file and remove the "cash in the `
      + `millions" page 8 exclusion in packSheetCount.test.ts.\n  ${lines}`)
      .toBeGreaterThan(1.08);
  }, 300_000);
});
