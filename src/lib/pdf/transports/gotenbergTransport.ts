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
//       --api-timeout=60s \
//       --chromium-allow-list='^https?://(app\.isaflow\.co\.za|host\.docker\.internal:3200)/'
//
// --api-timeout must stay STRICTLY ABOVE GOTENBERG_TIMEOUT_MS (gotenbergForm.ts,
// currently 55s) — Gotenberg's own default is 30s, shorter than the client's
// wait, so a slow pack would hit the server-side abort while the client was
// still waiting and the failure would read as a client timeout. Equal is not
// good enough either: two clocks reaching the same number is a race, and only
// the server's answer says what actually went wrong.
//
// --chromium-allow-list is what contains the print-token cookie's bare `domain`
// scope (gotenbergForm.ts). It cannot be asserted from this repo — the flag is
// on the docker run line, and Gotenberg's /health and /version report neither
// flags nor configuration — so selectTransport.ts logs a warning on every boot
// that selects this transport until GOTENBERG_ALLOW_LIST_VERIFIED=true says an
// operator has checked the running container.
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
const PDF_MAGIC = '%PDF';

function htmlPart(html: string): Blob {
  return new Blob([`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`], {
    type: 'text/html',
  });
}

export const gotenbergTransport: PdfTransport = {
  name: 'gotenberg',
  // Gotenberg's Chromium route takes the document information dictionary as a
  // form field (see gotenbergForm.ts), so metadata survives the render.
  capabilities: { metadata: true },
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
    form.append('files', htmlPart(request.footerHtml ?? FOOTER_HTML), 'footer.html');

    // new URL(..., base) rather than string concatenation, so a trailing
    // slash on GOTENBERG_URL cannot build a double-slash path.
    const endpoint = new URL(CONVERT_PATH, base).toString();
    const response = await fetch(endpoint, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(GOTENBERG_TIMEOUT_MS),
    });

    if (!response.ok) {
      // Never log or interpolate the response body: a 400 on a malformed
      // form field can echo that field's value back, and the `cookies`
      // field is where the print token lives. Status alone identifies the
      // failure class without any risk of leaking it.
      log.error('gotenbergTransport: render failed', { status: response.status }, 'pdf');
      throw new Error(`Gotenberg error: ${response.status}`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    const magic = bytes.subarray(0, 4).toString('latin1');
    if (magic !== PDF_MAGIC) {
      log.error('gotenbergTransport: response is not a PDF', { url: request.url }, 'pdf');
      throw new Error('Gotenberg error: response was not a PDF');
    }

    log.info('gotenbergTransport: rendered', { url: request.url, bytes: bytes.length }, 'pdf');
    return bytes;
  },
};
