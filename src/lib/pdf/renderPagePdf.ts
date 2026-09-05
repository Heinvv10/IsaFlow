// src/lib/pdf/renderPagePdf.ts
//
// Renders one authenticated app page to a PDF buffer via a headless
// browser. The launch is isolated behind `launchChromium()` so the
// transport (Playwright's bundled Chromium today, possibly Gotenberg in
// Docker later — decision pending) can change without touching callers.
//
// Auth: mints a print token (src/lib/pdf/printAuth.ts) bound to the exact
// API path the target page fetches its data from, and hands it to the
// browser context in the SAME cookie GoTrue uses (ACCESS_COOKIE). Edge
// middleware only checks that cookie is present, not its shape, so page
// navigation passes unchanged; `withAuth` is what actually verifies it
// (src/lib/auth/withAuth.ts).
//
// Scope note: a page that fetches more than one distinct API path (several
// report pages do) needs one token per path — this renderer supports a
// single `apiPath` today. Widen to `apiPaths: string[]` when a multi-fetch
// page is added to the pipeline.

import { chromium, type Browser } from 'playwright';
import { mintPrintToken } from './printAuth';
import { ACCESS_COOKIE, ACTIVE_COMPANY_COOKIE, ONBOARDING_DONE_COOKIE } from '@/lib/auth/cookies';
import { log } from '@/lib/logger';

const PDF_MARGIN = { top: '18mm', bottom: '18mm', left: '14mm', right: '14mm' };
const PRINT_READY_SELECTOR = '[data-print-ready="true"]';
const PRINT_READY_TIMEOUT_MS = 30_000;

async function launchChromium(): Promise<Browser> {
  return chromium.launch({ headless: true });
}

export interface RenderPagePdfOptions {
  companyId: string;
  userId: string;
  /** Page path to navigate to, e.g. /accounting/reports/management-accounts */
  path: string;
  /**
   * Exact API pathname (no query string) the print token authorizes, e.g.
   * /api/accounting/reports-management-accounts. Defaults to `path` for a
   * page whose data route matches its own path.
   */
  apiPath?: string;
  landscape?: boolean;
}

export async function renderPagePdf(options: RenderPagePdfOptions): Promise<Buffer> {
  const appUrl = process.env.APP_URL;
  if (!appUrl) throw new Error('APP_URL is not set');

  const { companyId, userId, path, landscape = false } = options;
  const apiPath = options.apiPath ?? path;
  const token = mintPrintToken(companyId, userId, [apiPath]);

  const browser = await launchChromium();
  try {
    const { hostname } = new URL(appUrl);
    const context = await browser.newContext();
    await context.addCookies([
      { name: ACCESS_COOKIE, value: token, domain: hostname, path: '/', httpOnly: true, sameSite: 'Lax' },
      { name: ACTIVE_COMPANY_COOKIE, value: companyId, domain: hostname, path: '/', httpOnly: false, sameSite: 'Lax' },
      // Middleware redirects any authed request without this cookie to
      // /onboarding, which would navigate away from the report entirely.
      { name: ONBOARDING_DONE_COOKIE, value: '1', domain: hostname, path: '/', httpOnly: false, sameSite: 'Lax' },
    ]);

    // The print token only authorizes `apiPath`. AppLayout still fires its
    // own background calls (preferences, setup-guide, company list, /auth/me)
    // which have no GoTrue session and would otherwise 401 — withAuth no
    // longer clears cookies for those (see withAuth.ts), but there is no
    // reason to let them hit the network, retry, or race the report fetch at
    // all. Stub every other /api/* call with a harmless empty envelope so the
    // page's own error handling (already built for "no data yet") takes over,
    // and only the authorized path reaches the server.
    await context.route('**/api/**', async (route) => {
      const requestPath = new URL(route.request().url()).pathname;
      if (requestPath === apiPath) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: null }),
      });
    });

    const page = await context.newPage();
    // 'load' rather than 'networkidle': the app keeps background connections
    // open (analytics beacon, polling) that never go quiet, so networkidle
    // would just wait out its own timeout. waitForSelector below is the real
    // readiness gate.
    await page.goto(`${appUrl}${path}?print=1`, { waitUntil: 'load' });
    await page.waitForSelector(PRINT_READY_SELECTOR, { timeout: PRINT_READY_TIMEOUT_MS });

    // print.css scopes its rules to `html.print-mode` under `@media print` so
    // an ordinary user's Ctrl+P is never affected — only this renderer ever
    // adds the class. Also strip `.dark` rather than maintain a parallel set
    // of print-scoped light-token overrides that would drift as new tokens
    // are added: removing it makes every `--ff-*` custom property fall back
    // to its `:root` (light) definition automatically.
    await page.evaluate(() => {
      document.documentElement.classList.add('print-mode');
      document.documentElement.classList.remove('dark');
    });
    // page.pdf() does not reliably force print media on its own — without
    // this, styles/print.css's @media print rules never applied and the
    // rendered PDF showed the full app shell.
    await page.emulateMedia({ media: 'print' });

    const pdf = await page.pdf({
      format: 'A4',
      landscape,
      printBackground: true,
      margin: PDF_MARGIN,
      displayHeaderFooter: true,
      // Empty headerTemplate suppresses Chromium's default title/date header;
      // only the page-number footer the brief specifies should render.
      headerTemplate: '<span></span>',
      footerTemplate:
        '<div style="font-size:9px;width:100%;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    });

    log.info('renderPagePdf: rendered', { companyId, userId, path }, 'pdf');
    return pdf;
  } finally {
    await browser.close();
  }
}
