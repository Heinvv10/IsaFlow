/**
 * THE PRINTED PDF, ENGINE AGAINST ENGINE: a pack printed by the production image's Gotenberg and by the print tests'
 * Chromium (`page.pdf`, the transports' paper and margins), each with the pack's faces served and loaded, compared as
 * printed: the sheet count and each sheet's size, and every word on every sheet with its box (`pdftotext -bbox`). That
 * covers the page breaks, where each footnote lands, the landscape sheets, and the text sizes the stylesheet takes from
 * `100cqw` at the real print width.
 */
import { execFileSync } from 'node:child_process';
import type { Browser } from 'playwright';
import { PAPER_A4_IN, PDF_MARGIN_MM, mm } from '@/lib/pdf/pdfTransport';
import { gotenbergPdf, servedPage, withPdfFile, type Gotenberg } from './gotenbergParity';
import { UNLOADED_FACES, flatStylesheet } from './parityPage';

/** A script for the printed page: once the faces have loaded, it says which did not, on the last sheet, and is done. */
const FONTS_LINE = `(async function () {
  await Promise.all(Array.from(document.fonts).map(function (f) { return f.load().catch(function () { return null; }); }));
  await document.fonts.ready;
  var unloaded = ${UNLOADED_FACES};
  var p = document.createElement('p');
  p.textContent = 'FONTS|' + (unloaded.length === 0 ? 'all-loaded' : unloaded.join(','));
  document.body.appendChild(p);
  window.parityDone = true;
})();`;

/** The pack's printed document: its markup under the print stylesheet, faces served beside it. */
export function printedDocument(body: string): { html: string; fonts: ReturnType<typeof flatStylesheet>['fonts'] } {
  const { css, fonts } = flatStylesheet();
  return { html: `<!doctype html><html class="print-mode"><head><meta charset="utf-8"><style>${css}</style></head><body>${body}<script>${FONTS_LINE}</script></body></html>`, fonts };
}

/** A printed PDF as its sheets: each sheet's size and its words with their boxes, as `pdftotext -bbox` reads them. */
export function sheetsOf(pdf: Buffer): string[] {
  const xml = withPdfFile(pdf, (file) => execFileSync('pdftotext', ['-bbox', file, '-'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
  return xml.split('<page ').slice(1).map((page) => page.replace(/<\/page>[\s\S]*$/, '').replace(/\s+/g, ' ').trim());
}

/** What differs between two engines' prints of one pack: the sheet count, then the first sheet that differs. */
export function sheetDifferences(a: string[], b: string[]): string[] {
  const wrong: string[] = [];
  const fonts = (sheets: string[]) => /FONTS\|([^<]*)</.exec(sheets.join(' '))?.[1];
  if (fonts(a) !== 'all-loaded' || fonts(b) !== 'all-loaded') wrong.push(`faces: Gotenberg ${fonts(a)}, Playwright ${fonts(b)}`);
  if (a.length !== b.length) wrong.push(`${a.length} sheets in Gotenberg, ${b.length} in Playwright`);
  const at = a.findIndex((sheet, i) => sheet !== b[i]);
  if (at >= 0) {
    const wa = a[at]!.split('<word ');
    const wb = (b[at] ?? '').split('<word ');
    const w = wa.findIndex((word, j) => word !== wb[j]);
    wrong.push(`sheet ${at + 1}: Gotenberg ${wa[w]?.slice(0, 120)} / Playwright ${wb[w]?.slice(0, 120)}`);
  }
  return wrong;
}

export async function printBoth(gotenberg: Gotenberg, browser: Browser, body: string): Promise<{ gotenberg: string[]; playwright: string[] }> {
  const { html, fonts } = printedDocument(body);
  const g = sheetsOf(await gotenbergPdf(gotenberg, html, fonts, 'window.parityDone === true'));
  const page = await servedPage(browser, html, fonts, 1000);
  try {
    await page.waitForFunction(() => (window as unknown as { parityDone?: boolean }).parityDone === true);
    // The paper Gotenberg is sent (`gotenbergForm.ts`): 8.27 x 11.69in.
    const pdf = await page.pdf({ width: `${PAPER_A4_IN.width}in`, height: `${PAPER_A4_IN.height}in`, printBackground: true, margin: { top: mm(PDF_MARGIN_MM.top), bottom: mm(PDF_MARGIN_MM.bottom), left: mm(PDF_MARGIN_MM.left), right: mm(PDF_MARGIN_MM.right) } });
    return { gotenberg: g, playwright: sheetsOf(Buffer.from(pdf)) };
  } finally {
    await page.close();
  }
}
