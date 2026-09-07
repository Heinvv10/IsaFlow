/**
 * Print the board pack to a real PDF, in Chromium, and count the SHEETS.
 *
 * WHY THIS EXISTS. The model asserted twelve pages, the unit tests pinned
 * twelve, 302 unit tests and 432 component tests were green — and the first
 * PDF anyone actually printed was NINETEEN sheets. Every logical page whose
 * content outgrew its box silently spilled onto a second sheet, and no
 * assertion in the suite could see it, because a page's HEIGHT is not a
 * property of the model. `doc.pages.length` is what the pack INTENDS; the
 * sheet count is what a director receives.
 *
 * It renders the same components the app renders, through the same print
 * stylesheets, at the same paper size and margins the transports use
 * (`PDF_MARGIN_MM` — the single source of truth). It does NOT go through the
 * dev server or the PDF transports: those need a database, a session and a
 * print token, none of which decides pagination. What decides pagination is
 * the markup, the CSS and the paper, and all three are real here.
 *
 * THE FONTS ARE REAL TOO, and that is not a detail: a fallback face has
 * different metrics, so a pack that fits under Liberation Sans and overflows
 * under IBM Plex would pass a test that let Chromium fall back. The woff2
 * files are served from `public/fonts` by a route interception.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium, type Browser } from 'playwright';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import { HEADER_HTML, PDF_MARGIN_MM, mm } from '@/lib/pdf/pdfTransport';
import type { PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';

const ROOT = path.resolve(__dirname, '../../..');
const HOST = 'http://pack.print.local/';

/**
 * `body { margin: 0 }`, which the app gets from Tailwind's preflight and this
 * harness does not load. It is not cosmetic: the UA default is 8px, and 8px
 * of top margin above a 255mm page box is enough to push every single page
 * onto a second sheet. Without it this harness measures its own missing
 * reset rather than the pack.
 */
const PREFLIGHT = 'body{margin:0}';

/** `styles/print.css` with its one `@import` inlined — Chromium would fetch
 *  it, and there is no server here to fetch it from. */
function printStylesheet(): string {
  const print = readFileSync(path.join(ROOT, 'styles/print.css'), 'utf8');
  const pack = readFileSync(path.join(ROOT, 'styles/packPrint.css'), 'utf8');
  return `${PREFLIGHT}${print.replace(/@import\s+'\.\/packPrint\.css';/, pack)}`;
}

export interface PrintedPack {
  /** Sheets of paper, from the PDF itself. The number that matters. */
  sheets: number;
  /**
   * The text on each sheet, in order.
   *
   * The diagnostic is taken from the PRINTED document rather than by
   * measuring element heights in a second layout: a page's box measured in a
   * browser viewport and the same page laid out for paper are two different
   * layouts, and the first was reporting a 787mm page that in fact printed
   * comfortably on one sheet. A test whose diagnosis is itself unreliable is
   * worse than one that only says the count is wrong.
   */
  sheetText: string[];
  /**
   * How far the widest thing on the page runs past the right edge of the
   * paper, in CSS pixels. Zero on a document that fits.
   *
   * Horizontal overflow is invisible in a sheet count and invisible in a
   * page count: the content is simply GONE from the printed page, clipped at
   * the paper's edge with nothing to say it was ever there. That is a worse
   * failure than a nineteen-sheet pack, and it is the failure mode a fix for
   * a nineteen-sheet pack most easily introduces.
   */
  overflow: Array<{ id: string; over: number; widest: string }>;
  /**
   * How tall each `.pack-page` box actually is, in millimetres, beside the
   * box the paper gives it.
   *
   * The sheet count says a page spilled; it never says by how much, and
   * "expected 14 to be 12" sent every previous reader to open a PDF by hand
   * and guess. A page 3mm over is a padding change and a page 60mm over is a
   * page carrying more than fits — the two need opposite fixes.
   */
  heights: Array<{
    id: string; mm: number; boxMm: number; overMm: number;
    /** Each direct child of the page box and its own height, for a page that
     *  is over — the block to shrink, named, instead of guessed at. Empty on
     *  a page that fits. */
    blocks: Array<{ what: string; mm: number }>;
  }>;
  pdf: Buffer;
}

/** A4 portrait, less the transports' top and bottom margins. The height one
 *  sheet can hold — `.pack-page`'s own `min-height` is set to this. */
export const CONTENT_BOX_MM = 297 - PDF_MARGIN_MM.top - PDF_MARGIN_MM.bottom;

/** A4 landscape, less the same margins — the box a `[data-print-landscape]`
 *  page is printed into, and 87mm shorter than the portrait one. */
export const LANDSCAPE_BOX_MM = 210 - PDF_MARGIN_MM.top - PDF_MARGIN_MM.bottom;

const PX_PER_MM = 96 / 25.4;

/** A landscape sheet's content width — A4's long edge less the same left and
 *  right margins. */
const LANDSCAPE_WIDTH_PX = Math.round((297 - PDF_MARGIN_MM.left - PDF_MARGIN_MM.right) * PX_PER_MM);

export async function printBoardPack(
  document: PackPagesDocument,
  browser: Browser,
  /** The running footer the route passes to the transport. Absent, Chromium
   *  draws none — which is what every pack printed before the route was wired
   *  to `buildFooterHtml`, and the reason a sheet count could pass while no
   *  page named the company, the period or the confidentiality mark. */
  footerHtml?: string,
): Promise<PrintedPack> {
  const body = renderToStaticMarkup(<PackPagesView document={document} />);
  const html =
    '<!doctype html><html class="print-mode"><head><meta charset="utf-8">' +
    `<style>${printStylesheet()}</style></head><body>${body}</body></html>`;

  // The viewport is the PAPER's content box, not a screen: 174mm wide (A4
  // less the left and right margins) at 96dpi. Measured at 1280px the pages
  // wrap differently and every height read back is a height no sheet ever
  // has — the measurement has to happen at the width the document is printed
  // at or it describes a different document.
  const page = await browser.newPage({
    viewport: {
      width: Math.round((210 - PDF_MARGIN_MM.left - PDF_MARGIN_MM.right) * PX_PER_MM),
      height: Math.round(CONTENT_BOX_MM * PX_PER_MM),
    },
  });
  try {
    await page.route(`${HOST}**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') {
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
      }
      if (url.pathname.startsWith('/fonts/')) {
        return route.fulfill({
          contentType: 'font/woff2',
          body: readFileSync(path.join(ROOT, 'public', url.pathname)),
        });
      }
      return route.abort();
    });
    await page.goto(HOST, { waitUntil: 'load' });
    await page.emulateMedia({ media: 'print' });
    // The self-hosted IBM Plex faces are `font-display: block`, so a render
    // that did not wait would measure the fallback's metrics.
    await page.evaluate(() => document.fonts.ready);

    // Measured at the paper's own content width — the viewport is set to it
    // above — so this is the document overflowing the SHEET, not a browser
    // window.
    // A landscape page's content box is 261mm wide, not 174mm — measured
    // against the portrait box every landscape page reads as 90mm too wide,
    // which is the harness's viewport, not the pack.
    const overflow = await page.evaluate((boxes) => {
      const box = document.documentElement.clientWidth;
      const out: Array<{ id: string; over: number; widest: string }> = [];
      for (const el of Array.from(document.querySelectorAll('.pack-page'))) {
        const page = el as HTMLElement;
        const limit = page.hasAttribute('data-print-landscape') ? boxes.landscape : box;
        const over = page.scrollWidth - limit;
        if (over <= 0) continue;
        let widest = '';
        let max = 0;
        for (const child of Array.from(page.querySelectorAll('*'))) {
          const w = (child as HTMLElement).scrollWidth;
          if (w > max) { max = w; widest = `${child.tagName.toLowerCase()}.${child.className} ${w}px`; }
        }
        out.push({ id: page.id || 'page', over, widest });
      }
      return out;
    }, { landscape: LANDSCAPE_WIDTH_PX });

    const heights = await page.evaluate((mmPerPx) => {
      return Array.from(document.querySelectorAll('.pack-page')).map((el) => {
        const box = el as HTMLElement;
        const boxMm = box.hasAttribute('data-print-landscape') ? mmPerPx.landscape : mmPerPx.portrait;
        const mm = Math.round((box.scrollHeight / mmPerPx.px) * 10) / 10;
        const overMm = Math.round((mm - boxMm) * 10) / 10;
        const blocks = overMm <= 0.2 ? [] : Array.from(box.children).map((child) => ({
          what: `${child.tagName.toLowerCase()}.${child.className || '-'}`,
          mm: Math.round(((child as HTMLElement).getBoundingClientRect().height / mmPerPx.px) * 10) / 10,
        }));
        return { id: box.id || 'page', mm, boxMm, overMm, blocks };
      });
    }, { px: PX_PER_MM, portrait: CONTENT_BOX_MM, landscape: LANDSCAPE_BOX_MM });

    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      // Chromium prints its own title/date header unless handed an empty one
      // — the same pair the transports use (`HEADER_HTML`).
      ...(footerHtml === undefined ? {} : {
        displayHeaderFooter: true,
        headerTemplate: HEADER_HTML,
        footerTemplate: footerHtml,
      }),
      margin: {
        top: mm(PDF_MARGIN_MM.top),
        bottom: mm(PDF_MARGIN_MM.bottom),
        left: mm(PDF_MARGIN_MM.left),
        right: mm(PDF_MARGIN_MM.right),
      },
    });

    // `pdf-parse` is already a dependency, and the count comes from the
    // DOCUMENT rather than from anything this harness believes about how tall
    // a page was — the two disagreeing is the whole defect.
    const { PDFParse } = (await import('pdf-parse')) as unknown as {
      PDFParse: new (o: { data: Buffer }) => {
        getText(): Promise<{ total: number; pages: Array<{ text: string }> }>;
      };
    };
    const { total, pages } = await new PDFParse({ data: pdf }).getText();
    return { sheets: total, sheetText: pages.map((p) => p.text), overflow, heights, pdf };
  } finally {
    await page.close();
  }
}

export async function withChromium<T>(fn: (browser: Browser) => Promise<T>): Promise<T> {
  const browser = await chromium.launch();
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}
