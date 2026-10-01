/**
 * The Playwright double the transport tests share: a browser whose connection
 * state, print-error attributes and wait timing a test controls.
 */
import { vi } from 'vitest';

/**
 * A PDF the metadata writer can actually amend: a classic cross-reference
 * table and a literal trailer, which is the shape Chromium's Skia writer
 * emits. It used to be `%PDF-1.7 fake` — and `writePdfInfoDictionary` leaves a
 * file it does not understand alone, so every metadata assertion made against
 * those bytes would have passed on a transport that went on ignoring
 * `request.metadata` entirely.
 */
export const pdfBytes = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Producer (Skia/PDF) >>\nendobj\n' +
  'xref\n0 1\n0000000000 65535 f \n' +
  'trailer\n<</Size 2\n/Root 1 0 R\n/Info 1 0 R>>\nstartxref\n60\n%%EOF\n',
  'latin1',
);

/** A Playwright double: a browser whose connection state we control. */
export const waitCalls: Array<{ fn: (a: string[]) => boolean; arg: string[]; timeout: number }> = [];
/** Called as each wait "happens", so a test can let time pass during it. */
let duringWait: ((timeout: number) => void) | null = null;
export function setDuringWait(fn: ((timeout: number) => void) | null): void { duringWait = fn; }

/** The attributes the print page would carry: `'fonts: …'` / `'pages: …'` land
 *  under their producer's own attribute name, as `markPrintError` writes them. */
function attributesFor(printError: string | string[] | null): Array<{ name: string; value: string }> {
  return (printError === null ? [] : [printError].flat()).map((value) => ({
    name: `data-print-error-${value.split(':')[0]}`, value,
  }));
}

type PageState = { attrs: Array<{ name: string; value: string }>; ready: boolean };

/** `script` is what the page looks like at each successive read after a wait;
 *  by default it is whatever `printError` implies, ready when nothing failed. */
export function makeBrowser(printError: string | string[] | null = null, script?: PageState[]) {
  let reads = 0;
  const contexts: Array<{ closed: boolean }> = [];
  const listeners: Array<() => void> = [];
  const browser = {
    connected: true,
    isConnected: () => browser.connected,
    on: (event: string, fn: () => void) => { if (event === 'disconnected') listeners.push(fn); },
    close: vi.fn(async () => { browser.connected = false; listeners.forEach(f => f()); }),
    newContext: vi.fn(async () => {
      const ctx = {
        closed: false,
        addCookies: vi.fn(async () => {}),
        route: vi.fn(async () => {}),
        close: vi.fn(async () => { ctx.closed = true; }),
        newPage: vi.fn(async () => ({
          goto: vi.fn(async () => {}),
          waitForFunction: vi.fn(async (fn: (a: string[]) => boolean, arg: string[], opts: { timeout: number }) => {
            waitCalls.push({ fn, arg, timeout: opts.timeout });
            duringWait?.(opts.timeout);
          }),
          // Runs the transport's OWN function against a document that carries
          // the markers under their real names only, so reading any other
          // attribute name finds nothing and the render succeeds.
          evaluate: vi.fn(async (fn: (a: string[]) => unknown, arg: string[]) => {
            const state = script?.[Math.min(reads++, script.length - 1)]
              ?? { attrs: attributesFor(printError), ready: printError === null };
            vi.stubGlobal('document', {
              querySelector: () => (state.ready ? {} : null),
              documentElement: { attributes: state.attrs },
            });
            try { return fn(arg); } finally { vi.unstubAllGlobals(); }
          }),
          emulateMedia: vi.fn(async () => {}),
          pdf: vi.fn(async () => pdfBytes),
        })),
      };
      contexts.push(ctx);
      return ctx;
    }),
    contexts,
    /** A crash Playwright reports: the disconnected event fires. */
    crash: () => { browser.connected = false; listeners.forEach(f => f()); },
    /** A browser that is gone without the event having reached us — an
     *  external kill, or a listener lost. isConnected() is the only signal. */
    dieSilently: () => { browser.connected = false; },
  };
  return browser;
}

export const request = {
  url: 'http://localhost:3200/accounting/reports/report-packs?print=1',
  landscape: false,
  cookies: [{ name: 'sb-access-token', value: 'tok', httpOnly: true }],
  allowedApiPaths: ['/api/accounting/reports-pack'],
};
