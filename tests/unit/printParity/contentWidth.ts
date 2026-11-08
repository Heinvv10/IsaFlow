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
import { servedPage, withPdfFile } from './gotenbergParity';
import { parityDocument } from './parityPage';

const STEP = 1 / 64;

const line = (w: number, orientation: PageOrientation): string => `<div ${orientation === 'landscape' ? 'data-print-landscape ' : ''}style="break-after:page">`
  + `<span style="display:inline-block;max-width:100%;width:${w}px">A</span> <span style="display:inline-block;width:1px;font-size:1px">B</span></div>`;

/** The pack stylesheet's page (its `@page` rules included) holding `body`, with no parity script and no fixed width. */
export function flipDocument(body: string): { html: string; fonts: ReturnType<typeof parityDocument>['fonts'] } {
  const { html, fonts } = parityDocument('');
  return { html: html.replace(/<script>[\s\S]*<\/script>/, '').replace(/html\{width:[\d.]+px\}/, '').replace('<body>', `<body>${body}`), fonts };
}

/** The narrowest block that wraps in a page laid out `widthPx` wide (print media, the pack's faces loaded). */
export async function domFlip(browser: Browser, widthPx: number): Promise<number> {
  const { html, fonts } = flipDocument(line(100, 'portrait'));
  const page = await servedPage(browser, html, fonts, Math.ceil(widthPx) + 1);
  try {
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

/**
 * THE SECOND METHOD: a container query, read in the print itself. Sheet i holds a box as wide as the page's content and
 * prints "YES" when that box is at least `thresholds[i]` wide (`@container (min-width: ...)`). No glyph advance enters
 * it: the widest threshold met says how wide the content is, to the step between thresholds.
 */
export function containerDocument(thresholds: readonly number[], orientation: PageOrientation): { html: string; fonts: ReturnType<typeof parityDocument>['fonts'] } {
  const css = thresholds.map((t, i) => `@container (min-width:${t}px){.cq${i}::after{content:"YES"}}`).join('');
  const body = thresholds.map((t, i) => `<div ${orientation === 'landscape' ? 'data-print-landscape ' : ''}style="break-after:page;container-type:inline-size;width:100%"><div class="cq${i}">S${i} </div></div>`).join('');
  const doc = flipDocument(body);
  return { html: doc.html.replace('</head>', `<style>${css}</style></head>`), fonts: doc.fonts };
}

/** The widest threshold the printed `pdf` met, and the next (the content width lies between); every sheet in order. */
export function containerWidth(pdf: string, thresholds: readonly number[]): { atLeast: number; under: number } {
  const sheets = execFileSync('pdftotext', ['-raw', pdf, '-'], { encoding: 'utf8' }).split('\f').filter((p) => p.trim() !== '');
  if (sheets.length !== thresholds.length) throw new Error(`${sheets.length} sheets for ${thresholds.length} thresholds`);
  const met = sheets.map((p) => p.includes('YES'));
  const last = met.lastIndexOf(true);
  if (last < 0 || last === met.length - 1 || met.slice(0, last + 1).some((m) => !m)) throw new Error(`thresholds not bracketed: ${met.map(Number).join('')}`);
  return { atLeast: thresholds[last]!, under: thresholds[last + 1]! };
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

/** A block `h` px tall and, after it, a 1px line holding "B": one sheet while the line fits under the block. */
const spillBody = (h: number, orientation: PageOrientation): string => `<div ${orientation === 'landscape' ? 'data-print-landscape' : ''}>`
  + `<div style="height:${h}px"></div><div style="height:1px;font-size:1px;line-height:1px">B</div></div>`;

export type PrintPdf = (html: string, fonts: ReturnType<typeof parityDocument>['fonts']) => Promise<Buffer>;

const sheetsOf = (pdf: Buffer): number => withPdfFile(pdf, (file) => Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [file], { encoding: 'utf8' }))![1]));

/**
 * Where an engine's printed page box is, measured three ways against the constants: the line flip (a line wraps in the
 * PDF exactly where it wraps in a page laid out `width` wide), the container query (the content box reads 1/64px more
 * than the width lines break at), and the spill (a 1px line just fits under a block `height - 1` tall, and a block
 * 1/64px taller pushes it to a second sheet).
 */
export async function pageBoxProblems(browser: Browser, print: PrintPdf, orientation: PageOrientation, width: number, height: number): Promise<string[]> {
  const wrong: string[] = [];
  const flip = await domFlip(browser, width);
  const widths = candidates(flip - 8 / 64, 17);
  const lines = flipDocument(candidateBody(widths, orientation));
  const printed = withPdfFile(await print(lines.html, lines.fonts), (file) => pdfFlip(file, widths));
  if (printed !== flip) wrong.push(`line flip: laid out ${width}px wide it flips at ${flip}, printed at ${printed}`);
  const thresholds = candidates(width - 1, 129);
  const cq = containerDocument(thresholds, orientation);
  const box = withPdfFile(await print(cq.html, cq.fonts), (file) => containerWidth(file, thresholds));
  if (box.atLeast !== width + 1 / 64) wrong.push(`container query: the box reads at least ${box.atLeast}, under ${box.under}`);
  const fits = flipDocument(spillBody(height - 1, orientation));
  const spills = flipDocument(spillBody(height - 1 + 1 / 64, orientation));
  const fitsPdf = await print(fits.html, fits.fonts);
  if (sheetsOf(fitsPdf) !== 1) wrong.push(`spill: a line under a block ${height - 1}px tall spilled`);
  // The sheet is the one the pack's own `@page` rules ask for (A4, and A4 landscape for a named landscape page), not
  // the paper the transport passes: neither transport sets preferCSSPageSize, and the rules apply all the same.
  const [w, h] = withPdfFile(fitsPdf, (file) => /Page size:\s+([\d.]+) x ([\d.]+)/.exec(execFileSync('pdfinfo', [file], { encoding: 'utf8' }))!.slice(1).map(Number));
  if ((orientation === 'landscape') !== (w! > h!)) wrong.push(`sheet: ${w} x ${h}pt is not ${orientation}`);
  if (sheetsOf(await print(spills.html, spills.fonts)) !== 2) wrong.push(`spill: a line under a block ${height - 1 + 1 / 64}px tall stayed`);
  return wrong;
}
