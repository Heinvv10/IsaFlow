// src/lib/pdf/transports/gotenbergForm.ts
//
// The multipart FIELDS of a Gotenberg /forms/chromium/convert/url request,
// as a plain object so they can be asserted without a container running.
// The file parts (header.html, footer.html) are added by the transport.

import {
  PAPER_A4_IN, PDF_MARGIN_MM, PRINT_READY_SELECTOR, PRINT_READY_TIMEOUT_MS,
  mmToIn, type PdfRenderRequest,
} from '../pdfTransport';

export function buildGotenbergFields(request: PdfRenderRequest): Record<string, string> {
  const cookieHeader = request.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  return {
    url: request.url,
    paperWidth: PAPER_A4_IN.width.toFixed(2),
    paperHeight: PAPER_A4_IN.height.toFixed(2),
    marginTop: mmToIn(PDF_MARGIN_MM.top),
    marginBottom: mmToIn(PDF_MARGIN_MM.bottom),
    marginLeft: mmToIn(PDF_MARGIN_MM.left),
    marginRight: mmToIn(PDF_MARGIN_MM.right),
    landscape: String(request.landscape),
    printBackground: 'true',
    emulatedMediaType: 'print',
    // The same gate the Playwright transport waits on. A waitDelay would be a
    // guess that either truncates a slow pack or wastes seconds on a fast one.
    waitForExpression: `document.querySelector('${PRINT_READY_SELECTOR}') !== null`,
    // The app holds background connections open, so network-idle never fires.
    skipNetworkIdleEvent: 'true',
    extraHttpHeaders: JSON.stringify({ Cookie: cookieHeader }),
  };
}

export const GOTENBERG_TIMEOUT_MS = PRINT_READY_TIMEOUT_MS + 30_000;
