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
 * THE SAME BASELINE THE APPLICATION LOADS, not a one-line stand-in for it.
 *
 * This was `body{margin:0}` — the single preflight rule anyone had noticed
 * mattering — and the gap it left was not theoretical. The live Brightsphere
 * pack printed TWELVE sheets under this harness and THIRTEEN through the
 * route, off the same document, because `.pack-page`'s children inherit a
 * different set of element defaults here than they do in the app: the UA
 * gives `ol` a 1em margin and a 40px indent and `figure` a 1em/40px margin,
 * and Tailwind's preflight zeroes both. A harness that certifies a document
 * the route spills is worse than no harness, because the number it reports
 * is the one a reviewer trusts.
 *
 * So it loads what `pages/_app.tsx` loads, in the order it loads it:
 * Tailwind's own preflight, then `styles/globals.css`, then
 * `styles/print.css`.
 *
 * TAILWIND'S GENERATED UTILITIES ARE NOT COMPILED HERE, AND ONE OF THEM IS
 * LOAD-BEARING. Producing the real utilities layer means running the Tailwind
 * compiler over the rendered markup, which is a build step inside a unit
 * test. The pack's markup uses six, all on `PackPagesView`'s outer wrapper
 * (`mx-auto max-w-[210mm] bg-white p-0 text-[…]`) plus one error paragraph
 * the print path never renders — and `max-w-[210mm]` is not the no-op it
 * looks like. It capped the 261mm LANDSCAPE sheet at portrait width, so the
 * trends page was set across two thirds of its paper and ran 10-14mm taller
 * than it needed to, which is what made the pack thirteen sheets on one
 * company while this harness reported twelve off the same document.
 *
 * So that one declaration is restated below, in the cascade position the
 * compiled utilities layer occupies — before `print.css`, which is what has
 * to beat it. It is not a copy of a value for its own sake: it is the thing
 * `packPrint.css`'s `html.print-mode .pack-pages { max-width: none }` exists
 * to override, and without it here that override could be deleted with this
 * harness still green.
 *
 * The other five change no box. If a utility ever appears INSIDE a
 * `.pack-page` — on a block, a tile, a table — this reasoning is void and the
 * compiler has to run.
 */

/**
 * The one Tailwind utility on the pack's markup that changes a page's
 * measure, in the cascade position Tailwind's own output would put it.
 */
const WRAPPER_UTILITIES = '.pack-pages{margin-left:auto;margin-right:auto;max-width:210mm}';
function printStylesheet(): string {
  // The literal file `@tailwind base` emits. Read from the installed package
  // so a Tailwind upgrade moves this harness with the app rather than leaving
  // it measuring last year's defaults.
  const preflight = readFileSync(
    path.join(ROOT, 'node_modules/tailwindcss/lib/css/preflight.css'), 'utf8');
  // `@tailwind` is a build directive, not CSS; the `@layer base`/`@layer
  // utilities` blocks around this file's own rules are left standing, because
  // a layered rule loses to an unlayered one and that is the same order the
  // compiled cascade puts them in against `print.css`.
  const globals = readFileSync(path.join(ROOT, 'styles/globals.css'), 'utf8')
    .replace(/@tailwind\s+[a-z]+;/g, '');
  const print = readFileSync(path.join(ROOT, 'styles/print.css'), 'utf8');
  const pack = readFileSync(path.join(ROOT, 'styles/packPrint.css'), 'utf8');
  return preflight + globals + WRAPPER_UTILITIES
    + print.replace(/@import\s+'\.\/packPrint\.css';/, pack);
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
  /**
   * The cover's brand band as the printing browser resolved it — see the
   * `page.evaluate` below for why these five properties and not a pixel
   * count. Null when the pack has no cover.
   */
  coverBand: {
    /** The words in the band. Empty is the defect: a solid navy rectangle
     *  across the top of page 1 with nothing in it. */
    text: string;
    /** The resolved `content` of the band — `'none'` or an empty string is
     *  the empty navy rectangle that shipped. */
    content: string;
    background: string;
    heightPx: number;
    top: string;
    opacity: number;
    colorAdjust: string;
  } | null;
  heights: Array<{
    id: string; mm: number; boxMm: number; overMm: number; landscape: boolean;
    /** What the page's content measures, margins between blocks included and
     *  `.pack-page`'s own sheet-high `min-height` excluded. `mm` answers "did
     *  this spill"; this answers "is the composer's ruler honest". */
    contentMm: number;
    /** Each direct child of the page box and its own height, for a page that
     *  is over — the block to shrink, named, instead of guessed at. Empty on
     *  a page that fits. */
    blocks: Array<{ what: string; mm: number }>;
  }>;
  /**
   * The NAME each sheet prints in its title position — `.pack-page-header
   * .pack-page-name` — as the printing browser painted it, or null where
   * nothing is painted there.
   *
   * Positional, and the reason is the guard it replaces: asserting the nav
   * label appears ANYWHERE on the sheet passed on six of the ten content
   * pages with the title hidden, because those pages' conclusion sentences
   * happen to contain the label's letters. A test that passes because its
   * search string is a substring of unrelated prose is not asserting what its
   * name says.
   *
   * Read from the laid-out DOM under print media rather than from the PDF
   * text, because a PDF is a flat bag of glyphs with no idea which of them is
   * a heading. Visibility is resolved rather than assumed: an element with no
   * client rects, `visibility: hidden`, or zero opacity paints nothing, and
   * that is exactly the mutation this must go red on.
   */
  pageNames: Array<string | null>;
  /**
   * The two columns of page 4, as the printing browser sized them: the
   * commentary (or its pending placeholder) and the derived action panel.
   *
   * Measured because nothing else could see the fix. The placeholder column
   * ran at 2fr and held one italic line over 1 130 blank pixel-rows;
   * `.pack-narrative-columns.is-pending` gives the measure to the panel
   * instead. `thinSheets` counts characters per SHEET, so a sheet that is
   * full down one side and empty down the other passes it, and no test
   * referenced `is-pending` at all — deleting the CSS rule and the className
   * together left the whole suite green.
   *
   * Null where the pack's commentary is approved, which is the case this does
   * not describe.
   */
  pendingNarrative: { placeholderMm: number; panelMm: number } | null;
  /**
   * How wide the landscape page is actually laid out, in millimetres, at the
   * landscape viewport. Null where the pack has no landscape page.
   *
   * A page's HEIGHT is a function of its measure, so a page silently set
   * across the wrong width reports a height no sheet ever has — and this one
   * was, by `max-w-[210mm]` on the wrapper. The sheet count could not see it
   * and the height could not be trusted; this is the number that says which.
   */
  landscapeWidthMm: number | null;
  /**
   * Class tokens found INSIDE a `.pack-page` that are not the pack's own.
   *
   * The whole no-margin argument rests on this harness laying a page out the
   * way the application does, and it loads everything the app loads EXCEPT
   * Tailwind's compiled utilities. That is only safe while no utility reaches
   * inside a page box — true today, and a promise about the future that only
   * a reader of this file would ever check. This is the check.
   *
   * An ALLOW-LIST, not a list of known utilities: `pack-` for the pack's own
   * classes and `is-` for its state classes. A deny-list would have to
   * enumerate Tailwind, which generates class names on demand
   * (`max-w-[210mm]`), and would pass the first one nobody thought of.
   */
  foreignClassNames: string[];
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

    const measure = (mmPerPx: { px: number; portrait: number; landscape: number }) =>
      Array.from(document.querySelectorAll('.pack-page')).map((el) => {
        const box = el as HTMLElement;
        const boxMm = box.hasAttribute('data-print-landscape') ? mmPerPx.landscape : mmPerPx.portrait;
        const mm = Math.round((box.scrollHeight / mmPerPx.px) * 10) / 10;
        const overMm = Math.round((mm - boxMm) * 10) / 10;
        const blocks = Array.from(box.children).map((child) => ({
          what: `${child.tagName.toLowerCase()}.${child.className || '-'}`,
          mm: Math.round(((child as HTMLElement).getBoundingClientRect().height / mmPerPx.px) * 10) / 10,
        }));
        // What the page's CONTENT measures, as against the box it sits in.
        // `.pack-page` has a `min-height` of the whole sheet, so `scrollHeight`
        // reads 255mm for a half-empty page — the right number for "did this
        // spill" and useless for "did the composer's ruler read short".
        const gaps = box.querySelectorAll(':scope > [data-pack-block]').length - 1;
        const contentMm = Math.round((
          blocks.reduce((sum, b) => sum + b.mm, 0)
          + Math.max(0, gaps) * mmPerPx.blockGap
          + (box.hasAttribute('data-print-landscape') ? mmPerPx.landscapeHeaderMargin : mmPerPx.headerMargin)
        ) * 10) / 10;
        return {
          id: box.id || 'page', mm, contentMm, boxMm, overMm, blocks,
          landscape: box.hasAttribute('data-print-landscape'),
        };
      });

    const geometry = {
      px: PX_PER_MM,
      portrait: CONTENT_BOX_MM,
      landscape: LANDSCAPE_BOX_MM,
      // `--pack-baseline` between two blocks, and the same value under
      // `.pack-page-header` — neither is inside any child's own box.
      blockGap: 4.5,
      headerMargin: 4.5,
      /** `.pack-page[data-print-landscape] .pack-page-header` halves it. */
      landscapeHeaderMargin: 2,
    };
    const portraitPass = await page.evaluate(measure, geometry);

    // A LANDSCAPE PAGE IS 261mm WIDE, AND THIS VIEWPORT IS 174.
    //
    // Every height above is read from a layout at the PORTRAIT measure, which
    // is the right one for eleven of the twelve pages and wrong for the one
    // that prints sideways: page 10 laid out at 174mm reported 187mm in a
    // 168mm box on four fixtures while printing, correctly, on one sheet. A
    // diagnostic that cries wolf on the one page nobody can check by eye is
    // worse than none, and it is why this harness could report an overflowing
    // page and a passing sheet count at the same time. So the landscape pages
    // are re-measured in a second layout at their own width.
    await page.setViewportSize({
      width: LANDSCAPE_WIDTH_PX,
      height: Math.round(LANDSCAPE_BOX_MM * PX_PER_MM),
    });
    const landscapePass = await page.evaluate(measure, geometry);
    const foreignClassNames = await page.evaluate(() => {
      const found = new Set<string>();
      for (const box of Array.from(document.querySelectorAll('.pack-page'))) {
        for (const el of [box, ...Array.from(box.querySelectorAll('*'))]) {
          // Inside a chart's SVG the classes are ECharts' own
          // (`zr005b9e3d-1`), generated per render and styled by nothing: the
          // markup arrives pre-rendered from `renderChartSvg` with its
          // presentation inline and its box fixed by the `<figure>`'s own
          // height. No stylesheet reaches them, so their absence from this
          // harness cannot change a measurement.
          if (el.namespaceURI === 'http://www.w3.org/2000/svg') continue;
          for (const token of (el.getAttribute('class') ?? '').split(/\s+/)) {
            if (token === '') continue;
            if (token.startsWith('pack-') || token.startsWith('is-')) continue;
            found.add(token);
          }
        }
      }
      return [...found].sort();
    });

    const landscapeWidthMm = await page.evaluate((pxPerMm) => {
      const el = document.querySelector('.pack-page[data-print-landscape]');
      if (el === null) return null;
      return Math.round((el.getBoundingClientRect().width / pxPerMm) * 10) / 10;
    }, PX_PER_MM);
    await page.setViewportSize({
      width: Math.round((210 - PDF_MARGIN_MM.left - PDF_MARGIN_MM.right) * PX_PER_MM),
      height: Math.round(CONTENT_BOX_MM * PX_PER_MM),
    });
    const heights = portraitPass.map((h, i) => (h.landscape ? landscapePass[i]! : h));

    const pageNames = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.pack-page')).map((el) => {
        const name = el.querySelector('.pack-page-header .pack-page-name');
        if (name === null) return null;
        const style = getComputedStyle(name);
        const painted = (name as HTMLElement).getClientRects().length > 0
          && style.visibility !== 'hidden'
          && Number.parseFloat(style.opacity) > 0;
        if (!painted) return null;
        return (name.textContent ?? '').replace(/\s+/g, ' ').trim();
      });
    });

    // The cover's brand band, as the printing browser resolved it.
    //
    // Not a pixel count — this harness has no PNG decoder — but it is read
    // off the LAID-OUT page under print media, and it is the exact set of
    // properties that failed: the band shared a pseudo-element with the DRAFT
    // watermark, so it printed at 6% opacity, rotated, in the middle of the
    // sheet. `opacity` and `top` are what say which of the two won.
    const coverBand = await page.evaluate(() => {
      const el = document.querySelector('.pack-cover');
      if (el === null) return null;
      const band = getComputedStyle(el, '::after');
      return {
        /** What the band PRINTS — it shipped as an empty navy rectangle. */
        text: (el as HTMLElement).dataset.brandName ?? '',
        /** The band's own `content`, so an empty band is caught in the CSS
         *  and not only in the attribute that feeds it. */
        content: band.content,
        background: band.backgroundColor,
        heightPx: Number.parseFloat(band.height),
        top: band.top,
        opacity: Number.parseFloat(band.opacity),
        colorAdjust: band.printColorAdjust,
      };
    });

    // Page 4's two columns, on the fixture whose commentary is pending.
    const pendingNarrative = await page.evaluate((pxPerMm) => {
      const columns = document.querySelector('.pack-narrative-columns.is-pending');
      if (columns === null) return null;
      const placeholder = columns.querySelector('.pack-narrative-pending');
      const panel = columns.querySelector('.pack-narrative-actions');
      if (placeholder === null || panel === null) return null;
      const mmOf = (el: Element) =>
        Math.round((el.getBoundingClientRect().width / pxPerMm) * 10) / 10;
      return { placeholderMm: mmOf(placeholder), panelMm: mmOf(panel) };
    }, PX_PER_MM);

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
    return {
      sheets: total, sheetText: pages.map((p) => p.text), overflow, heights,
      coverBand, pageNames, pendingNarrative, landscapeWidthMm, foreignClassNames, pdf,
    };
  } finally {
    await page.close();
  }
}

/** What one small-multiples panel is actually painted as, on paper. */
export interface PaintedPanel {
  title: string;
  /** The plot box, in CSS pixels — what `.pack-chart-svg` got. */
  plotPx: number;
  /** How many PAGE pixels one SVG user unit buys, vertically. This is the
   *  number a shared-scale claim is about: the domain can be shared in the
   *  SVG's user space and still be painted at two scales. */
  pxPerUserUnit: number;
}

/**
 * THE PANELS ON PAGE 10, MEASURED ON THE PAINTED PAGE.
 *
 * The money group's y-domain is shared in the SVG's user space — that was
 * measured by least squares over the plotted vertices and it is true to eight
 * figures. It is also not the claim the page makes to a reader, who is looking
 * at paper. `.pack-chart-svg` used to take `flex: 1` of what the caption left
 * inside a fixed-height figure, so a panel with a two-line title was painted
 * at 0.74275 page pixels per user unit against its neighbours' 0.85523: one
 * domain, two scales, under a caption saying the scale is shared.
 *
 * `getScreenCTM` is what settles it — it is the transform the browser will
 * actually paint with, viewBox, `preserveAspectRatio` and box size together.
 * Every previous attempt to adjudicate this read gridlines off a raster and
 * settled nothing.
 */
export async function measurePaintedPanels(
  document: PackPagesDocument,
  browser: Browser,
): Promise<PaintedPanel[]> {
  const body = renderToStaticMarkup(<PackPagesView document={document} />);
  const html =
    '<!doctype html><html class="print-mode"><head><meta charset="utf-8">' +
    `<style>${printStylesheet()}</style></head><body>${body}</body></html>`;

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
    await page.evaluate(() => document.fonts.ready);

    return await page.evaluate(() => {
      const panels = Array.from(document.querySelectorAll('.pack-small-multiples .pack-chart'));
      return panels.map((figure) => {
        const box = figure.querySelector('.pack-chart-svg') as HTMLElement;
        const svg = box.querySelector('svg') as SVGSVGElement;
        const ctm = svg.getScreenCTM()!;
        const at = (y: number) => {
          const point = svg.createSVGPoint();
          point.x = 0;
          point.y = y;
          return point.matrixTransform(ctm).y;
        };
        const height = Number((svg.getAttribute('viewBox') ?? '0 0 0 1').split(/\s+/)[3]);
        return {
          title: figure.querySelector('.pack-chart-title')?.textContent ?? '',
          plotPx: box.getBoundingClientRect().height,
          pxPerUserUnit: (at(height) - at(0)) / height,
        };
      });
    });
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
