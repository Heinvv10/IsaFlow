// src/lib/pdf/transports/gotenbergTransport.ts
//
// Gotenberg Docker sidecar — Chromium URL → PDF. Same operational shape as
// the WeasyPrint sidecar (src/modules/accounting/services/afs/weasyprintService.ts).
//
// Setup on velo:
//   docker run -d \
//     --name gotenberg \
//     --restart unless-stopped \
//     -p 5002:3000 \
//     --add-host host.docker.internal:host-gateway \
//     gotenberg/gotenberg:8 gotenberg \
//       --chromium-allow-list='^https?://(app\.isaflow\.co\.za|host\.docker\.internal:3200)/'
//
// Set GOTENBERG_URL=http://localhost:5002 in the systemd service environment
// (production) and in .env.local for a local container. Unset, renderPagePdf
// uses the Playwright transport instead — see selectTransport.ts.
//
// Verify:
//   curl --request POST http://localhost:5002/forms/chromium/convert/url \
//     --form url=https://gotenberg.dev --output test.pdf
//
// NOTE: Gotenberg fetches the URL itself, from inside the container. APP_URL
// must therefore be reachable FROM the container (host.docker.internal in dev,
// the real hostname in production) and must be on the chromium-allow-list.
//
// NOTE: unlike the Playwright transport, Gotenberg cannot intercept the page's
// own requests, so background /api/* calls are not stubbed. They 401 — the
// print token authorises only `allowedApiPaths` — and withAuth deliberately
// does NOT clear cookies for a valid token bound elsewhere, so the report
// fetch is unaffected. A page in this pipeline must tolerate a 401 on any call
// outside its authorised set.
//
// NOTE: the print token and its sibling cookies are sent via Gotenberg's
// `cookies` form field (see gotenbergForm.ts), scoped to the app host — never
// via `extraHttpHeaders`, which would attach the Cookie header to every
// cross-origin resource the page loads and leak the token off-domain.

import { buildGotenbergFields, GOTENBERG_TIMEOUT_MS } from './gotenbergForm';
import { FOOTER_HTML, HEADER_HTML, type PdfRenderRequest, type PdfTransport } from '../pdfTransport';
import { log } from '@/lib/logger';

const CONVERT_PATH = '/forms/chromium/convert/url';

function htmlPart(html: string): Blob {
  return new Blob([`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`], {
    type: 'text/html',
  });
}

export const gotenbergTransport: PdfTransport = {
  name: 'gotenberg',
  async render(request: PdfRenderRequest): Promise<Buffer> {
    const base = process.env.GOTENBERG_URL;
    if (!base) throw new Error('GOTENBERG_URL is not set');

    const form = new FormData();
    for (const [key, value] of Object.entries(buildGotenbergFields(request))) {
      form.append(key, value);
    }
    // Chromium renders these two as the running header and footer. The header
    // is empty so Chromium's default title/date line is suppressed.
    form.append('files', htmlPart(HEADER_HTML), 'header.html');
    form.append('files', htmlPart(FOOTER_HTML), 'footer.html');

    const response = await fetch(`${base}${CONVERT_PATH}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(GOTENBERG_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      log.error('gotenbergTransport: render failed', { status: response.status, body }, 'pdf');
      throw new Error(`Gotenberg error: ${response.status} ${body}`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    log.info('gotenbergTransport: rendered', { url: request.url, bytes: bytes.length }, 'pdf');
    return bytes;
  },
};
