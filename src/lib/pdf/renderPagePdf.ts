// src/lib/pdf/renderPagePdf.ts
//
// Renders one authenticated app page to a PDF buffer. The browser lives
// behind PdfTransport (src/lib/pdf/pdfTransport.ts): Gotenberg in Docker when
// GOTENBERG_URL is set, Playwright's bundled Chromium otherwise.
//
// Auth: mints a print token (printAuth.ts) bound to the exact SET of API
// paths the target page fetches, and hands it to the browser in the SAME
// cookie GoTrue uses (ACCESS_COOKIE). Edge middleware only checks the cookie
// is present; withAuth is what verifies it.
//
// The page is responsible for adding `print-mode` to <html> and dropping
// `.dark` when it sees ?print=1 — Gotenberg cannot execute a script on our
// behalf, so the page, not the renderer, owns that.

import { mintPrintToken } from './printAuth';
import { ACCESS_COOKIE, ACTIVE_COMPANY_COOKIE, ONBOARDING_DONE_COOKIE } from '@/lib/auth/cookies';
import { chooseTransportName } from './selectTransport';
import { playwrightTransport } from './transports/playwrightTransport';
import { gotenbergTransport } from './transports/gotenbergTransport';
import type { PdfTransport } from './pdfTransport';
import { log } from '@/lib/logger';

export interface RenderPagePdfOptions {
  companyId: string;
  userId: string;
  /** Page path, e.g. /accounting/reports/report-packs */
  path: string;
  /** Extra query parameters. `print=1` is always added. */
  query?: Record<string, string>;
  /**
   * Exact API pathnames (no query strings) the print token authorises.
   * Defaults to `[path]` for a page whose data route matches its own path.
   */
  apiPaths?: string[];
  landscape?: boolean;
}

function transportFor(name: ReturnType<typeof chooseTransportName>): PdfTransport {
  return name === 'gotenberg' ? gotenbergTransport : playwrightTransport;
}

export async function renderPagePdf(options: RenderPagePdfOptions): Promise<Buffer> {
  const appUrl = process.env.APP_URL;
  if (!appUrl) throw new Error('APP_URL is not set');

  const { companyId, userId, path, landscape = false } = options;
  const apiPaths = options.apiPaths ?? [path];
  const token = mintPrintToken(companyId, userId, apiPaths);

  const params = new URLSearchParams({ ...(options.query ?? {}), print: '1' });
  const url = `${appUrl}${path}?${params.toString()}`;

  const transport = transportFor(chooseTransportName(process.env));
  const pdf = await transport.render({
    url,
    landscape,
    allowedApiPaths: apiPaths,
    cookies: [
      { name: ACCESS_COOKIE, value: token, httpOnly: true },
      { name: ACTIVE_COMPANY_COOKIE, value: companyId, httpOnly: false },
      // Middleware redirects an authed request without this cookie to
      // /onboarding, which navigates away from the report entirely.
      { name: ONBOARDING_DONE_COOKIE, value: '1', httpOnly: false },
    ],
  });

  log.info('renderPagePdf: rendered', { companyId, userId, path, transport: transport.name, bytes: pdf.length }, 'pdf');
  return pdf;
}
