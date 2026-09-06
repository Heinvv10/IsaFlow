// src/lib/pdf/pdfTransport.ts
//
// The contract every PDF transport implements. A transport receives a fully
// built URL and the cookies that authenticate it, and returns PDF bytes. It
// knows nothing about print tokens, companies or report pages — that is
// renderPagePdf's job — so a new transport is one file and a registry entry
// in renderPagePdf.ts's `transports` map.

export interface PrintCookie {
  name: string;
  value: string;
  httpOnly: boolean;
}

export interface PdfMetadata {
  title: string;
  author: string;
  subject: string;
  creator: string;
}

export interface PdfRenderRequest {
  /** Absolute URL including the ?print=1 query. */
  url: string;
  landscape: boolean;
  cookies: PrintCookie[];
  /**
   * The API pathnames the page is allowed to call. The Playwright transport
   * stubs everything else so a background call cannot race the report fetch;
   * Gotenberg cannot intercept, so there the print token is the only gate
   * (an unauthorised call 401s and withAuth leaves the cookies alone).
   */
  allowedApiPaths: string[];
  /** Per-pack footer. Falls back to FOOTER_HTML when absent. */
  footerHtml?: string;
  /** Written into the PDF's document information dictionary. Gotenberg only —
   *  Playwright's page.pdf() supports no metadata at all, which is exactly why
   *  spec §8 decision 5 declines to make PDF/A a requirement. */
  metadata?: PdfMetadata;
}

export interface PdfTransport {
  name: 'playwright' | 'gotenberg';
  render(request: PdfRenderRequest): Promise<Buffer>;
}

/** A4 with the margins the reporting brief specifies, in both units the two
 *  transports want: Playwright takes CSS units, Gotenberg takes inches.
 *
 *  This is the SINGLE SOURCE OF TRUTH for the page margin. `styles/packPrint.css`
 *  declares `@page { size: A4; }` with no margin, deliberately: neither
 *  transport sets `preferCSSPageSize`, so Chromium ignores a CSS `@page`
 *  margin and always uses the margin the transport passes here instead. A
 *  margin added to that CSS file would be silently dropped. */
export const PDF_MARGIN_MM = { top: 20, bottom: 22, left: 18, right: 18 } as const;
export const MM_PER_INCH = 25.4;
export const PAPER_A4_IN = { width: 8.27, height: 11.69 } as const;

export const PRINT_READY_SELECTOR = '[data-print-ready="true"]';
export const PRINT_READY_TIMEOUT_MS = 30_000;

/** Chromium's page-number footer. Both transports render the same markup. */
export const FOOTER_HTML =
  '<div style="font-size:9px;width:100%;text-align:center;color:#555">' +
  '<span class="pageNumber"></span> / <span class="totalPages"></span></div>';

/** Chromium prints its own title/date header unless it is given an empty one. */
export const HEADER_HTML = '<span></span>';

export const mm = (v: number): string => `${v}mm`;
export const mmToIn = (v: number): string => (v / MM_PER_INCH).toFixed(2);
