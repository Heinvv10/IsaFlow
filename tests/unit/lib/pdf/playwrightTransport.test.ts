/**
 * ADVERSARIAL LOW-2: the transport launched a whole Chromium per render —
 * ~300-800ms of CPU and ~80MB before a byte is produced, on every pack export.
 * One browser is now reused for the life of the process and the per-render
 * isolation lives on the context, which is where cookies, storage and the
 * /api/** route stub already were.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const pdfBytes = Buffer.from('%PDF-1.7 fake');

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

const request = {
  url: 'http://localhost:3200/accounting/reports/report-packs?print=1',
  landscape: false,
  cookies: [{ name: 'sb-access-token', value: 'tok', httpOnly: true }],
  allowedApiPaths: ['/api/accounting/reports-pack'],
};

beforeEach(() => { launchMock.mockReset(); });
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
