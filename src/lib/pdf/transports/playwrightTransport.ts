// src/lib/pdf/transports/playwrightTransport.ts
//
// The dev/local transport: Playwright's bundled Chromium, in-process. It is
// the only transport that can intercept the page's network, so it stubs every
// /api/* call the print token does not authorise — the page's own "no data
// yet" handling takes over and nothing races the report fetch.

import { chromium, type Browser } from 'playwright';
import {
  FOOTER_HTML, HEADER_HTML, PDF_MARGIN_MM, PRINT_READY_SELECTOR, PRINT_READY_TIMEOUT_MS,
  mm, type PdfRenderRequest, type PdfTransport,
} from '../pdfTransport';
import { log } from '@/lib/logger';

// One Chromium for the life of the process, not one per render. A launch is
// ~300-800ms of CPU and ~80MB before a single byte is rendered, and the render
// bound (../renderSemaphore.ts) already caps how many contexts exist at once —
// so the browser is the expensive thing to keep and the CONTEXT is the thing
// that must be per-render. Contexts are isolated: cookies, storage and the
// /api/** route stub all live on the context, so two renders never see each
// other's print token.
let shared: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  // isConnected() is false after a crash or an external kill; a stale handle
  // would fail every later render for the life of the process.
  if (shared?.isConnected()) return shared;
  if (shared) {
    log.warn('playwrightTransport: browser was disconnected, relaunching', {}, 'pdf');
    shared = null;
  }
  shared = await chromium.launch({ headless: true });
  // A crash between renders must not leave a dead handle cached.
  shared.on('disconnected', () => { shared = null; });
  return shared;
}

export const playwrightTransport: PdfTransport = {
  name: 'playwright',
  async render(request: PdfRenderRequest): Promise<Buffer> {
    const { hostname } = new URL(request.url);
    const browser = await getBrowser();
    const context = await browser.newContext();
    try {
      await context.addCookies(
        request.cookies.map((c) => ({
          name: c.name, value: c.value, domain: hostname, path: '/',
          httpOnly: c.httpOnly, sameSite: 'Lax' as const,
        })),
      );

      const allowed = new Set(request.allowedApiPaths);
      await context.route('**/api/**', async (route) => {
        const requestPath = new URL(route.request().url()).pathname;
        if (allowed.has(requestPath)) {
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
      // 'load', not 'networkidle': the app keeps background connections open
      // that never go quiet. waitForSelector is the real readiness gate.
      await page.goto(request.url, { waitUntil: 'load' });
      await page.waitForSelector(PRINT_READY_SELECTOR, { timeout: PRINT_READY_TIMEOUT_MS });
      await page.emulateMedia({ media: 'print' });

      const pdf = await page.pdf({
        format: 'A4',
        landscape: request.landscape,
        printBackground: true,
        margin: {
          top: mm(PDF_MARGIN_MM.top), bottom: mm(PDF_MARGIN_MM.bottom),
          left: mm(PDF_MARGIN_MM.left), right: mm(PDF_MARGIN_MM.right),
        },
        displayHeaderFooter: true,
        headerTemplate: HEADER_HTML,
        footerTemplate: FOOTER_HTML,
      });
      log.info('playwrightTransport: rendered', { url: request.url, bytes: pdf.length }, 'pdf');
      return pdf;
    } finally {
      // The context goes, the browser stays. Closing the context releases the
      // page, its cookies and its route handlers; leaking one would keep this
      // render's print token alive in memory.
      await context.close().catch(() => { /* a crashed browser takes its contexts with it */ });
    }
  },
};

/** Close the shared browser. For test teardown and a future graceful shutdown;
 *  the next render relaunches on demand. */
export async function closeSharedBrowser(): Promise<void> {
  const browser = shared;
  shared = null;
  if (browser) await browser.close().catch(() => { /* already gone */ });
}
