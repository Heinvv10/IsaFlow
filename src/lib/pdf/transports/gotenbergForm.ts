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

function resolveAppOrigin(env: NodeJS.ProcessEnv | Record<string, string | undefined>): URL {
  const raw = env.APP_URL ?? env.NEXT_PUBLIC_APP_URL;
  if (!raw) throw new Error('gotenbergForm: APP_URL (or NEXT_PUBLIC_APP_URL) is not set');
  return new URL(raw);
}

export function buildGotenbergFields(
  request: PdfRenderRequest,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Record<string, string> {
  const appOrigin = resolveAppOrigin(env);
  // A Secure cookie is dropped by Chromium over http, which is what the
  // documented local setup (host.docker.internal:3200) uses — so this must
  // track the app's own scheme rather than assume production's https.
  const secure = appOrigin.protocol === 'https:';
  const cookies: GotenbergCookie[] = request.cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: appOrigin.hostname,
    path: '/',
    httpOnly: c.httpOnly,
    secure,
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
    // Matches the Gotenberg 8 default; set explicitly so the intent survives
    // an upstream default change.
    emulatedMediaType: 'print',
    // The same gate the Playwright transport waits on. A waitDelay would be a
    // guess that either truncates a slow pack or wastes seconds on a fast one.
    // JSON.stringify escapes the selector so a future selector containing a
    // quote cannot break out of the expression string.
    waitForExpression: `document.querySelector(${JSON.stringify(PRINT_READY_SELECTOR)}) !== null`,
    // Matches the Gotenberg 8 default (true); set explicitly because the app
    // holds background connections open, so network-idle would never fire if
    // this were ever false.
    skipNetworkIdleEvent: 'true',
    cookies: JSON.stringify(cookies),
  };
}

// Must stay under Gotenberg's own --api-timeout (documented as 60s in
// gotenbergTransport.ts) so the client never times out first and masks a
// server-side abort with a misleading client-side one.
export const GOTENBERG_TIMEOUT_MS = PRINT_READY_TIMEOUT_MS + 30_000;
