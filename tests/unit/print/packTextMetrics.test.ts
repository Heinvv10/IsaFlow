/**
 * THE RULER IS MEASURED AGAINST THE BROWSER, ON TEXT THE PACK CAN ACTUALLY
 * RECEIVE.
 *
 * The prose model is now `packProseLines.proseLines` (each word at the faces'
 * own widths, filled as the print fills a line); this holds it on text the
 * faces set. Text in a fallback face is held in production's image
 * (`printParity/packProseLinesImage.test.ts`): this Chromium's fallback faces
 * are not production's. What follows is the em table's history.
 *
 * `packTextMetrics` decides how many lines a string takes, and every page
 * budget is built on it. Its em table was fitted to English prose and gave
 * every codepoint outside that table `EM_DEFAULT` — 0.47em — including CJK,
 * which is a full em wide. The model called a line of Chinese two lines where
 * Chromium set three, and it UNDER-read, which is the direction that puts a
 * page on a second sheet.
 *
 * It is reachable with real data, not a hypothetical: the matters table
 * carries journal references and issue text straight out of a company's
 * ledger, which a user types.
 *
 * So the contract is asserted the same way `packSheetCount` asserts the page
 * model — against Chromium's own layout, in the real face, at the real size —
 * and in the direction that matters: the ruler may read long and may never
 * read short.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Browser } from 'playwright';
import { launchPrintChromium } from './printChromium';
import { proseLines } from '@/modules/accounting/services/packs/pages/packProseLines';
import { PROSE, type ProseStyle } from '@/modules/accounting/services/packs/pages/packProseStyles';
import { readPackPrintCss } from './packPrintCss';

const ROOT = path.resolve(__dirname, '../../..');
const HOST = 'http://text.metrics.local/';

/** Strings the pack could carry, in the scripts the faces set. */
const SAMPLES: Array<[string, string]> = [
  ['English prose', 'Targets are the platform defaults; a metric with no target is shown unscored rather than assumed met, and the page says so.'],
  ['digits and identifiers', 'Reversal of JE-2026-00417 against company d27bac33-0000-0000-0000-000000000000 on 2026-01-31, 1 234 567.89'],
  ['capitals', 'VAT CONTROL ACCOUNT RECONCILIATION FOR THE PERIOD ENDED 31 AUGUST 2026 — SARS VAT201 SUBMISSION'],
  ['Afrikaans', 'Die grootboekinskrywing is teruggeskryf omdat die bedrag nie ooreenstem met die staat se saldo nie.'],
  ['Cyrillic', 'Проводка не соответствует остатку по банковской выписке и требует проверки бухгалтерией.'],
  ['Greek', 'Η εγγραφή δεν συμφωνεί με το υπόλοιπο του τραπεζικού λογαριασμού και απαιτεί έλεγχο.'],
  /**
   * FIGURES IN PROSE, WITH THE SEPARATOR THE PACK ACTUALLY EMITS.
   *
   * `formatMoney` groups thousands with U+00A0 so a figure cannot split at
   * its own separator — the `4 128` break the eleventh gate found on
   * Brightsphere's page 11. JavaScript's `\s` MATCHES U+00A0, so a wrap
   * model splitting on `/\s+/` offers itself a break Chromium will never
   * take, and reads short on exactly the strings the pack sets in its
   * governance and disclosure prose. Long unbreakable runs, deliberately, so
   * a measure has to carry a whole figure or start a new line.
   */
  ['figures with a non-breaking separator',
    '1\u00a0234\u00a0567 2\u00a0345\u00a0678 3\u00a0456\u00a0789 4\u00a0567\u00a0890 5\u00a0678\u00a0901 '
    + '6\u00a0789\u00a0012 7\u00a0890\u00a0123 8\u00a0901\u00a0234 9\u00a0012\u00a0345 1\u00a0123\u00a0456 '
    + 'and the quantum is that credit, 4\u00a0128; net profit of (1\u00a0408) is that credit plus '
    + 'revenue and other income of (5\u00a0536).'],
];

/** Measures the pack sets prose across, each in its style. */
const MEASURES: Array<[ProseStyle, number]> = [
  [PROSE.disclosureBody, 174], [PROSE.disclosureBody, 116], [PROSE.footnote, 168], [PROSE.mattersCell, 34], [PROSE.narrativeBody, 110],
];

let browser: Browser;
beforeAll(async () => { browser = await launchPrintChromium(); }, 120_000);
afterAll(async () => { await browser?.close(); });

/** The lines Chromium sets each paragraph in: one per case, at its size and measure, in the real face. */
async function drawnLines(cases: ReadonlyArray<{ text: string; pt: number; widthMm: number }>): Promise<number[]> {
  const pack = readPackPrintCss(ROOT);
  const html = '<!doctype html><html class="print-mode"><head><meta charset="utf-8"><style>'
    + `body{margin:0;font-family:'IBM Plex Sans',sans-serif}${pack}</style></head><body>`
    + cases.map((c, i) =>
      `<p id="s${i}" style="margin:0;width:${c.widthMm}mm;font-size:${c.pt}pt;line-height:100pt">`
      + `${c.text}</p>`).join('')
    + '</body></html>';
  const page = await browser.newPage();
  try {
    await page.route(`${HOST}**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
      if (url.pathname.startsWith('/fonts/')) {
        return route.fulfill({ contentType: 'font/woff2', body: readFileSync(path.join(ROOT, 'public', url.pathname)) });
      }
      return route.abort();
    });
    await page.goto(HOST, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    // 100pt of leading per line makes the line COUNT readable off the
    // element's height without trusting a second height model.
    return await page.evaluate((n) => Array.from({ length: n }, (unused, i) => {
      const el = document.getElementById(`s${i}`)!;
      return Math.round(el.getBoundingClientRect().height / (100 * (96 / 72)));
    }), cases.length);
  } finally {
    await page.close();
  }
}

describe('the pack text ruler', () => {
  it('never counts fewer lines than Chromium sets, in any script', async () => {
    // One paragraph per sample per measure, at the real size, in the real
    // face — a fallback face has different advances and would measure a
    // different document.
    const cases = MEASURES.flatMap(([style, widthMm]) =>
      SAMPLES.map(([name, text]) => ({ name, text, style, pt: style.pt, widthMm })));
    const drawn = await drawnLines(cases);
    const short = cases
      .map((c, i) => ({ ...c, browser: drawn[i]!, model: proseLines(c.text, c.style, c.widthMm) }))
      .filter((c) => c.model < c.browser);
    expect(
      short.map((c) => `${c.name} at ${c.pt}pt/${c.widthMm}mm: model ${c.model}, browser ${c.browser}`),
      'the ruler reads short — the direction that puts a page on a second sheet',
    ).toEqual([]);
  }, 120_000);

  /**
   * AND A LINE IS SHAPED ACROSS EACH BREAK IN IT. A hyphen before a round capital kerns OUT ("a-O" is 0.2px wider than
   * "a-" and "O" apart at 10pt), so a chain of such pieces summed piece by piece reads its lines short; the model
   * measures each piece against the one before it. Swept over the measure, so a line that ends a join or two from full
   * is among the cases.
   */
  it('measures a hyphenated chain across its joins, never short at any measure', async () => {
    const chain = `Ref ${'Ca-Oa-Ga-Qa-'.repeat(12)}end and ${'sa-Ca-Oa-'.repeat(10)}done`;
    const cases = Array.from({ length: 121 }, (unused, i) => ({ text: chain, pt: PROSE.disclosureBody.pt, widthMm: 40 + i * 0.5 }));
    const drawn = await drawnLines(cases);
    const short = cases.filter((c, i) => proseLines(c.text, PROSE.disclosureBody, c.widthMm) < drawn[i]!).map((c) => c.widthMm);
    expect(short, 'mm at which the model reads the chain short').toEqual([]);
  }, 120_000);

  /**
   * AND IT DOES NOT OFFER ITSELF A BREAK THE BROWSER CANNOT TAKE.
   *
   * `formatMoney` groups thousands with U+00A0 so a figure cannot split at
   * its own separator — the `4 128` break the eleventh gate found set as "4"
   * and "128" on two lines of Brightsphere's page 11. JavaScript's `\s`
   * MATCHES U+00A0, so a wrap model splitting on `/\s+/` treats the
   * separator as a break opportunity and packs a figure's first group onto a
   * line the browser will leave short. That is the ruler reading SHORT, which
   * is the direction that puts a page on a second sheet.
   *
   * Asserted against the ruler directly: it is the single wrap decision that
   * has to be right, and the sample above holds it only where a paragraph's
   * fill happens to reach a figure.
   */
  it('does not break a figure at its own thousands separator', () => {
    const style = PROSE.disclosureBody;
    // THE MEASURE IS FOUND, NOT WRITTEN DOWN — the narrowest whole millimetre
    // at which one figure, "111 111", fits a line. There "1 111 111 1" sets
    // in three lines (the figure cannot share one with either "1"), and a
    // model that breaks at the separator fits it in two.
    const measureMm = [...Array(120).keys()]
      .map((n) => n + 1)
      .find((mm) => proseLines('111 111', style, mm) === 1);
    expect(measureMm, 'no measure fits the sample, so nothing is being tested').toBeDefined();
    expect(proseLines('1 111 111 1', style, measureMm!), 'the measure does not discriminate').toBe(2);
    expect(
      proseLines('1 111\u00a0111 1', style, measureMm!),
      `at ${measureMm}mm the ruler fitted a grouped figure beside a word, which it can only do `
        + 'by breaking it at its own thousands separator — a break the browser will '
        + 'never take, so the ruler reads short',
    ).toBe(3);
  });
});
