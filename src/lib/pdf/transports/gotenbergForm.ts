// src/lib/pdf/transports/gotenbergForm.ts
//
// The multipart FIELDS of a Gotenberg /forms/chromium/convert/url request,
// as a plain object so they can be asserted without a container running.
// The file parts (header.html, footer.html) are added by the transport.
//
// Cookies travel in the `cookies` field (Gotenberg's own JSON array), never
// in `extraHttpHeaders`: that header applies to EVERY resource the page
// loads, including any cross-origin one, so a Cookie header there would leak
// the print token off-domain. `cookies` is scoped per-cookie to `domain`,
// which we pin to the app host.

import {
  PAPER_A4_IN, PDF_MARGIN_MM, PRINT_READY_SELECTOR, PRINT_READY_TIMEOUT_MS,
  mmToIn, type PdfRenderRequest,
} from '../pdfTransport';

interface GotenbergCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Lax';
}

function resolveAppHost(env: NodeJS.ProcessEnv | Record<string, string | undefined>): string {
  const raw = env.APP_URL ?? env.NEXT_PUBLIC_APP_URL;
  if (!raw) throw new Error('gotenbergForm: APP_URL (or NEXT_PUBLIC_APP_URL) is not set');
  return new URL(raw).hostname;
}

export function buildGotenbergFields(
  request: PdfRenderRequest,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Record<string, string> {
  const appHost = resolveAppHost(env);
  const cookies: GotenbergCookie[] = request.cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: appHost,
    path: '/',
    httpOnly: c.httpOnly,
    secure: true,
    sameSite: 'Lax',
  }));

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
    cookies: JSON.stringify(cookies),
  };
}

export const GOTENBERG_TIMEOUT_MS = PRINT_READY_TIMEOUT_MS + 30_000;
