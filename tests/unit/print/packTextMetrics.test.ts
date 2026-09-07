/**
 * THE RULER IS MEASURED AGAINST THE BROWSER, ON TEXT THE PACK CAN ACTUALLY
 * RECEIVE.
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
import { chromium, type Browser } from 'playwright';
import { wrappedLines } from '@/modules/accounting/services/packs/pages/packTextMetrics';

const ROOT = path.resolve(__dirname, '../../..');
const HOST = 'http://text.metrics.local/';

/** Strings the pack could carry, one per script the em table has to survive. */
const SAMPLES: Array<[string, string]> = [
  ['English prose', 'Targets are the platform defaults; a metric with no target is shown unscored rather than assumed met, and the page says so.'],
  ['digits and identifiers', 'Reversal of JE-2026-00417 against company d27bac33-0000-0000-0000-000000000000 on 2026-01-31, 1 234 567.89'],
  ['capitals', 'VAT CONTROL ACCOUNT RECONCILIATION FOR THE PERIOD ENDED 31 AUGUST 2026 — SARS VAT201 SUBMISSION'],
  ['Afrikaans', 'Die grootboekinskrywing is teruggeskryf omdat die bedrag nie ooreenstem met die staat se saldo nie.'],
  ['Chinese', '这是一笔来自客户的付款，金额与银行对账单上的余额不符，需要财务部门在本月底之前完成核对。'],
  ['Japanese', 'この仕訳は銀行明細の残高と一致しないため、月末までに経理部門による照合が必要です。'],
  ['Korean', '이 분개는 은행 명세서의 잔액과 일치하지 않으므로 월말까지 회계 부서의 확인이 필요합니다.'],
  ['Cyrillic', 'Проводка не соответствует остатку по банковской выписке и требует проверки бухгалтерией.'],
  ['Greek', 'Η εγγραφή δεν συμφωνεί με το υπόλοιπο του τραπεζικού λογαριασμού και απαιτεί έλεγχο.'],
];

/** The three measures the pack actually sets prose across. */
const MEASURES: Array<[number, number]> = [[9.5, 174], [9.5, 116], [7.5, 168], [9, 34]];

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 120_000);
afterAll(async () => { await browser?.close(); });

describe('the pack text ruler', () => {
  it('never counts fewer lines than Chromium sets, in any script', async () => {
    const pack = readFileSync(path.join(ROOT, 'styles/packPrint.css'), 'utf8');
    // One paragraph per sample per measure, at the real size, in the real
    // face — a fallback face has different advances and would measure a
    // different document.
    const cases = MEASURES.flatMap(([pt, widthMm]) =>
      SAMPLES.map(([name, text]) => ({ name, text, pt, widthMm })));
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
      const drawn = await page.evaluate((n) => Array.from({ length: n }, (unused, i) => {
        const el = document.getElementById(`s${i}`)!;
        return Math.round(el.getBoundingClientRect().height / (100 * (96 / 72)));
      }), cases.length);

      const short = cases
        .map((c, i) => ({ ...c, browser: drawn[i]!, model: wrappedLines(c.text, c.pt, c.widthMm) }))
        .filter((c) => c.model < c.browser);
      expect(
        short.map((c) => `${c.name} at ${c.pt}pt/${c.widthMm}mm: model ${c.model}, browser ${c.browser}`),
        'the ruler reads short — the direction that puts a page on a second sheet',
      ).toEqual([]);
    } finally {
      await page.close();
    }
  }, 120_000);
});
