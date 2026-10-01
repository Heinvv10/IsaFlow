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
//
// RESIDUAL, accepted: `domain` is a bare hostname, and in the Chrome DevTools
// cookie shape Gotenberg forwards to, a domain attribute matches that host AND
// its subdomains — a host-only cookie needs the `url` form, which Gotenberg's
// schema does not expose. Its cookie object is documented as
// `{name, value, domain, path, secure, httpOnly, sameSite}` with the first
// three REQUIRED and no host-only or url variant, so a bare hostname is the
// tightest form expressible here.
//
// What contains it is the container's own `--chromium-allow-list`
// (gotenbergTransport.ts): Chromium may only navigate to the app host itself,
// so there is no subdomain for the widened cookie to be sent to. Narrowing the
// allow-list is the lever if that ever stops holding — not this field.

import {
  PAPER_A4_IN, PDF_MARGIN_MM, PRINT_ERROR_ATTRIBUTE_PREFIX, PRINT_READY_SELECTOR, PRINT_READY_TIMEOUT_MS,
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
    // The same gate the Playwright transport waits on — ready OR failed. A
    // waitDelay would be a guess that either truncates a slow pack or wastes
    // seconds on a fast one. JSON.stringify escapes the selector and the
    // prefix so neither can break out of the expression string.
    //
    // AN ERROR ATTRIBUTE MAKES THE EXPRESSION THROW, and that is the whole
    // mechanism. Measured against gotenberg/gotenberg:8: an expression that
    // throws is answered `400 … (waitForExpression) returned an exception` in
    // ~0.2 s with no PDF, while a healthy page resolves normally. An
    // expression that merely RESOLVED on the attribute would print the unready
    // page with a 200 (the earlier form of this), and `failOnConsoleExceptions`
    // is deliberately NOT used as the gate: it would fail every production
    // pack on any unrelated uncaught exception or unhandled rejection the
    // print page ever raised, healthy or not.
    waitForExpression:
      '(function () {'
      + ` var bad = Array.from(document.documentElement.attributes).filter(function (a) { return a.name.startsWith(${JSON.stringify(PRINT_ERROR_ATTRIBUTE_PREFIX)}); });`
      + " if (bad.length > 0) throw new Error('print page cannot render: ' + bad.map(function (a) { return a.value; }).join('; '));"
      + ` return document.querySelector(${JSON.stringify(PRINT_READY_SELECTOR)}) !== null;`
      + ' })()',
    // Matches the Gotenberg 8 default (true); set explicitly because the app
    // holds background connections open, so network-idle would never fire if
    // this were ever false.
    skipNetworkIdleEvent: 'true',
    cookies: JSON.stringify(cookies),
    // Playwright's page.pdf() has no metadata equivalent, so this field is
    // Gotenberg-only and optional — omitted entirely rather than sent empty,
    // so a form snapshot without it never implies "metadata cleared".
    ...(request.metadata
      ? {
          // The custom keys are sent too, under names that cannot collide
          // with the standard four — but Gotenberg's exiftool pass IGNORES a
          // key it has no tag for (measured: `Custom Metadata: no`), so they
          // arrive in the file only because `gotenbergTransport` writes them
          // itself afterwards. Kept here so a Gotenberg that learns to write
          // them needs no change.
          metadata: JSON.stringify({
            Title: request.metadata.title,
            Author: request.metadata.author,
            Subject: request.metadata.subject,
            Creator: request.metadata.creator,
            ...request.metadata.custom,
          }),
        }
      : {}),
  };
}

// STRICTLY under Gotenberg's own --api-timeout (60s, see gotenbergTransport.ts)
// so the SERVER's abort always lands first and the client reports what actually
// happened. It used to be exactly 60s — equal, not under — which is a race:
// whichever side's clock reached 60 first won, so the same slow render could
// surface as a Gotenberg 5xx or as a client-side AbortError depending on
// scheduling, and only one of those is diagnosable.
//
// 55s = the 30s print-ready gate plus 25s of transport and PDF-assembly
// overhead, leaving a 5s margin. Raising --api-timeout means raising this to
// match, in that order.
export const GOTENBERG_API_TIMEOUT_MS = 60_000;
export const GOTENBERG_CLIENT_MARGIN_MS = 5_000;
export const GOTENBERG_TIMEOUT_MS = PRINT_READY_TIMEOUT_MS + 25_000;
