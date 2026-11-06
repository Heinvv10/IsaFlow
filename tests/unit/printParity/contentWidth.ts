/**
 * WHERE A LINE WRAPS, IN A PAGE LAID OUT AT A GIVEN WIDTH AND IN A PRINTED PDF: the probe that measures the width a
 * page's content is printed at. A line holds a block of a given width (never wider than its line, so Chromium never
 * shrinks the page to fit) and, after a space, a 1px block holding "B"; it wraps once the block is wide enough. Laid out
 * at a width W, the line flips at one block width; printed, one candidate block width per sheet, the first sheet whose
 * "B" starts a line of its own says where the print flips. Equal flips are an equal content width, to the 1/64px
 * Chromium lays out in.
 */
import { execFileSync } from 'node:child_process';
import type { Browser } from 'playwright';
import type { PageOrientation } from '@/modules/accounting/services/packs/pages/packTextMetrics';
import { parityDocument } from './parityPage';

const STEP = 1 / 64;

const line = (w: number, orientation: PageOrientation): string => `<div ${orientation === 'landscape' ? 'data-print-landscape ' : ''}style="break-after:page">`
  + `<span style="display:inline-block;max-width:100%;width:${w}px">A</span> <span style="display:inline-block;width:1px;font-size:1px">B</span></div>`;

/** The pack stylesheet's page (its `@page` rules included) holding `body`, with no parity script and no fixed width. */
export function flipDocument(body: string): { html: string; fonts: ReturnType<typeof parityDocument>['fonts'] } {
  const { html, fonts } = parityDocument('');
  return { html: html.replace(/<script>[\s\S]*<\/script>/, '').replace(/html\{width:[\d.]+px\}/, '').replace('<body>', `<body>${body}`), fonts };
}

/** The narrowest block that wraps in a page laid out `widthPx` wide (print media). */
export async function domFlip(browser: Browser, widthPx: number): Promise<number> {
  const page = await browser.newPage({ viewport: { width: Math.ceil(widthPx) + 1, height: 800 } });
  try {
    await page.emulateMedia({ media: 'print' });
    await page.setContent(flipDocument(line(100, 'portrait')).html);
    return await page.evaluate((w) => {
      document.documentElement.style.width = `${w}px`;
      const [a, b] = Array.from(document.querySelectorAll('span')) as HTMLElement[];
      let lo = 0;
      let hi = Math.round(w * 64);
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        a!.style.width = `${mid / 64}px`;
        if (b!.getBoundingClientRect().left < a!.getBoundingClientRect().right) hi = mid; else lo = mid;
      }
      return hi / 64;
    }, widthPx);
  } finally {
    await page.close();
  }
}

/** One sheet per candidate block width, from `from` in 1/64px steps. */
export const candidates = (from: number, count: number): number[] => Array.from({ length: count }, (unused, i) => from + i * STEP);
export const candidateBody = (widths: readonly number[], orientation: PageOrientation): string => widths.map((w) => line(w, orientation)).join('');

/** The first candidate whose "B" wrapped in the printed `pdf`, or null where none did. */
export function pdfFlip(pdf: string, widths: readonly number[]): number | null {
  const sheets = execFileSync('pdftotext', ['-bbox', pdf, '-'], { encoding: 'utf8' }).split('<page ').slice(1);
  if (sheets.length !== widths.length) throw new Error(`${sheets.length} sheets for ${widths.length} candidates`);
  const at = sheets.findIndex((sheet) => {
    const a = /xMin="([\d.]+)"[^>]*>A</.exec(sheet);
    const b = /xMin="([\d.]+)"[^>]*>B</.exec(sheet);
    if (a === null || b === null) throw new Error('a sheet without its probe');
    return Number(b[1]) <= Number(a[1]) + 1;
  });
  return at < 0 ? null : widths[at]!;
}
