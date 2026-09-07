/**
 * ADVERSARIAL LOW-2: the transport launched a whole Chromium per render —
 * ~300-800ms of CPU and ~80MB before a byte is produced, on every pack export.
 * One browser is now reused for the life of the process and the per-render
 * isolation lives on the context, which is where cookies, storage and the
 * /api/** route stub already were.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * A PDF the metadata writer can actually amend: a classic cross-reference
 * table and a literal trailer, which is the shape Chromium's Skia writer
 * emits. It used to be `%PDF-1.7 fake` — and `writePdfInfoDictionary` leaves a
 * file it does not understand alone, so every metadata assertion made against
 * those bytes would have passed on a transport that went on ignoring
 * `request.metadata` entirely.
 */
const pdfBytes = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Producer (Skia/PDF) >>\nendobj\n' +
  'xref\n0 1\n0000000000 65535 f \n' +
  'trailer\n<</Size 2\n/Root 1 0 R\n/Info 1 0 R>>\nstartxref\n60\n%%EOF\n',
  'latin1',
);

/** A Playwright double: a browser whose connection state we control. */
function makeBrowser() {
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
          waitForSelector: vi.fn(async () => {}),
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

const launchMock = vi.fn();
vi.mock('playwright', () => ({ chromium: { launch: (...a: unknown[]) => launchMock(...a) } }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { playwrightTransport, closeSharedBrowser } = await import('@/lib/pdf/transports/playwrightTransport');
const { log } = await import('@/lib/logger');

const request = {
  url: 'http://localhost:3200/accounting/reports/report-packs?print=1',
  landscape: false,
  cookies: [{ name: 'sb-access-token', value: 'tok', httpOnly: true }],
  allowedApiPaths: ['/api/accounting/reports-pack'],
};

beforeEach(() => { launchMock.mockReset(); vi.mocked(log.warn).mockClear(); });
afterEach(async () => { await closeSharedBrowser(); });

describe('playwrightTransport — browser reuse', () => {
  it('launches Chromium once across two renders', async () => {
    const browser = makeBrowser();
    launchMock.mockResolvedValue(browser);

    await playwrightTransport.render(request);
    await playwrightTransport.render(request);

    expect(launchMock).toHaveBeenCalledTimes(1);
    // Isolation is per render, so each one still gets its own context.
    expect(browser.newContext).toHaveBeenCalledTimes(2);
  });

  it('closes each render context but never the shared browser', async () => {
    const browser = makeBrowser();
    launchMock.mockResolvedValue(browser);

    await playwrightTransport.render(request);
    await playwrightTransport.render(request);

    expect(browser.contexts.every(c => c.closed)).toBe(true);
    expect(browser.close).not.toHaveBeenCalled();
  });

  it('relaunches after the browser crashes instead of failing every later render', async () => {
    const first = makeBrowser();
    const second = makeBrowser();
    launchMock.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    await playwrightTransport.render(request);
    first.crash();

    await expect(playwrightTransport.render(request)).resolves.toEqual(pdfBytes);
    expect(launchMock).toHaveBeenCalledTimes(2);
    expect(second.newContext).toHaveBeenCalledTimes(1);
  });

  it('relaunches a browser that died without emitting disconnected', async () => {
    const first = makeBrowser();
    const second = makeBrowser();
    launchMock.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    await playwrightTransport.render(request);
    // No event: only isConnected() distinguishes this handle from a live one,
    // and caching it would fail every later render for the life of the process.
    first.dieSilently();

    await expect(playwrightTransport.render(request)).resolves.toEqual(pdfBytes);
    expect(launchMock).toHaveBeenCalledTimes(2);
    expect(first.newContext).toHaveBeenCalledTimes(1);
    expect(second.newContext).toHaveBeenCalledTimes(1);
  });

  it('still returns the rendered bytes', async () => {
    launchMock.mockResolvedValue(makeBrowser());
    await expect(playwrightTransport.render(request)).resolves.toEqual(pdfBytes);
  });
});

/**
 * Both transports now write PDF metadata.
 *
 * They get there differently: Gotenberg is told, and Playwright's `page.pdf()`
 * exposes no metadata OPTION, so this transport appends the Info dictionary to
 * the bytes Chromium returns (`writePdfInfoDictionary`). The old asymmetry was
 * not that Playwright could not do it — it was that nothing had. `pdfinfo` on
 * the rendered board pack read `Creator: Chromium` with no title, on a
 * document a director forwards to their bank, while the route dutifully passed
 * a title, an author and a subject the transport logged and threw away.
 *
 * PDF_TRANSPORT=playwright is the production incident fallback, so this is the
 * path that has to carry it, not the one that gets to be the exception.
 */
describe('playwrightTransport — metadata reaches the file', () => {
  const metadata = {
    title: 'Acme — Management pack — 2026',
    author: 'Acme', subject: 'Management pack for 2026', creator: 'IsaFlow',
    custom: { IsaFlowPack: 'Management pack', IsaFlowStatus: 'FINAL' },
  };

  it('claims BEST-EFFORT metadata, which is what it can honestly promise', () => {
    // Not `true`. `writePdfInfoDictionary` returns the file unchanged for any
    // PDF whose cross-reference section it does not recognise, and the
    // capability's own docblock tells call sites to gate PDF/A on it — a
    // promise this transport cannot keep for every input. Gotenberg's renderer
    // takes the metadata itself and is `guaranteed`.
    expect(playwrightTransport.capabilities.metadata).toBe('best-effort');
  });

  it('writes the metadata into the returned bytes', async () => {
    launchMock.mockResolvedValue(makeBrowser());
    const written = await playwrightTransport.render({ ...request, metadata });

    expect(written.length).toBeGreaterThan(pdfBytes.length);
    // The title, encoded — the em dashes in it make it a UTF-16 hex string.
    expect(written.toString('latin1')).toMatch(/\/Title <FEFF[0-9A-F]+>/);
    // And the non-standard keys, which are the ones `pdfinfo` counts under
    // `Custom Metadata` — the line the acceptance check reads.
    expect(written.toString('latin1')).toContain('/IsaFlowPack (Management pack)');
    expect(written.toString('latin1')).toContain('/IsaFlowStatus (FINAL)');
    // The original bytes are untouched underneath it: an incremental update
    // appends a revision, it never rewrites the page content.
    expect(written.subarray(0, pdfBytes.length).equals(pdfBytes)).toBe(true);
    expect(vi.mocked(log.warn).mock.calls.some(([m]) => String(m).includes('dropping PDF metadata'))).toBe(false);
  });

  it('still returns the PDF when there is no metadata to write', async () => {
    launchMock.mockResolvedValue(makeBrowser());
    await expect(playwrightTransport.render(request)).resolves.toEqual(pdfBytes);
  });
});
