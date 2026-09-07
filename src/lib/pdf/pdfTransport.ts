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
  /**
   * Keys that are NOT part of the PDF's standard Info dictionary, written
   * beside the four above.
   *
   * `pdfinfo` reports `Custom Metadata: no` for a file whose Info dictionary
   * holds only standard keys, however well populated it is — which is what
   * the acceptance check for this work reads, and what it still read after
   * Title/Author/Subject/Creator started arriving. These are the keys that
   * flip it, and they are not padding for the sake of the line: a document
   * management system that indexes a forwarded pack has no way to recover
   * "which period" or "draft or final" from a title string, and every one of
   * these is a field the pack already knows.
   */
  custom: Record<string, string>;
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
  /** Written into the PDF's document information dictionary. Honoured only by
   *  a transport whose `capabilities.metadata` is true — Playwright's
   *  page.pdf() supports no metadata at all, which is exactly why spec §8
   *  decision 5 declines to make PDF/A a requirement. */
  metadata?: PdfMetadata;
}

/**
 * How reliably a transport writes the metadata it is handed.
 *
 * NOT a boolean, and that is the point. It was `metadata: boolean`, and when
 * the Playwright transport learnt to append an Info dictionary to Chromium's
 * bytes it flipped to `true` — on a writer that returns the file UNCHANGED,
 * with a `log.warn`, for any PDF whose cross-reference section it does not
 * recognise. A capability whose own docblock tells call sites to gate
 * archival retention on it cannot be satisfied by a line in a log nobody
 * reads during an incident.
 *
 * - `guaranteed` — the renderer itself takes the metadata; if the render
 *   succeeded, the metadata is in the file. Gotenberg's Chromium route.
 * - `best-effort` — written by post-processing the rendered bytes, and the
 *   post-processing can decline. Playwright. A call site that must have the
 *   metadata (PDF/A) has to refuse this transport, which it can now express.
 *
 * Left deliberately at two members: a transport that writes none would be a
 * third, and there is no such transport to describe.
 */
export type PdfMetadataSupport = 'guaranteed' | 'best-effort';

export interface PdfTransport {
  name: 'playwright' | 'gotenberg';
  /** What this transport can actually honour. The two are NOT interchangeable
   *  — see `PdfMetadataSupport` — and PDF_TRANSPORT=playwright is the
   *  production incident fallback, so a guarantee that holds in steady state
   *  silently stops holding the day the switch is flipped. A requirement that
   *  is genuinely load-bearing (PDF/A for archival retention) must be
   *  enforced at the CALL SITE by reading this, rather than assumed. */
  readonly capabilities: { readonly metadata: PdfMetadataSupport };
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
