/**
 * What the Playwright transport does when the print page reports it can never
 * become ready (`data-print-error-*`), and how it keeps its deadline while it
 * waits. The browser double is shared with `playwrightTransport.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeBrowser, request, setDuringWait, waitCalls } from './playwrightDouble';

const launchMock = vi.fn();
vi.mock('playwright', () => ({ chromium: { launch: (...a: unknown[]) => launchMock(...a) } }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { playwrightTransport, closeSharedBrowser } = await import('@/lib/pdf/transports/playwrightTransport');
const { log } = await import('@/lib/logger');

beforeEach(() => { launchMock.mockReset(); vi.mocked(log.warn).mockClear(); });
afterEach(async () => { await closeSharedBrowser(); });

describe('playwrightTransport — a print page that reports it cannot render', () => {
  it('fails the render with the reported reason instead of waiting out the timeout', async () => {
    launchMock.mockResolvedValue(makeBrowser('fonts: footer face unreachable'));
    await expect(playwrightTransport.render(request)).rejects.toThrow(/cannot render: fonts: footer face unreachable/);
  });

  it('reads the attribute names the print page writes (usePrintMode / usePackPagesData)', async () => {
    const { PRINT_ERROR_ATTRIBUTE_PREFIX } = await import('@/lib/pdf/pdfTransport');
    const { markPrintError } = await import('@/components/accounting/packs/usePrintMode');
    expect(PRINT_ERROR_ATTRIBUTE_PREFIX).toBe('data-print-error');
    vi.stubGlobal('document', { documentElement: { setAttribute: vi.fn() } });
    vi.stubGlobal('reportError', vi.fn());
    markPrintError('fonts', 'x');
    const set = (document.documentElement.setAttribute as ReturnType<typeof vi.fn>).mock.calls[0]!;
    vi.unstubAllGlobals();
    expect((set[0] as string).startsWith(PRINT_ERROR_ATTRIBUTE_PREFIX)).toBe(true);
  });

  it('reports BOTH producers when both failed', async () => {
    launchMock.mockResolvedValue(makeBrowser(['fonts: footer face unreachable', 'pages: HTTP 422']));
    await expect(playwrightTransport.render(request)).rejects.toThrow(
      /cannot render: fonts: footer face unreachable; pages: HTTP 422$/,
    );
  });

  it('carries a pages-fetch refusal through with its status', async () => {
    launchMock.mockResolvedValue(makeBrowser('pages: HTTP 422'));
    await expect(playwrightTransport.render(request)).rejects.toThrow(/cannot render: pages: HTTP 422$/);
  });

  it('waits on ready OR error: the predicate is true for either, false for neither', async () => {
    waitCalls.length = 0;
    launchMock.mockResolvedValue(makeBrowser(null));
    await playwrightTransport.render(request);
    const { fn, arg } = waitCalls[0]!;
    const run = (ready: boolean, error: boolean) => {
      vi.stubGlobal('document', {
        querySelector: () => (ready ? {} : null),
        documentElement: { attributes: error ? [{ name: 'data-print-error-pages', value: 'pages: HTTP 500' }] : [{ name: 'lang', value: 'en' }] },
      });
      try { return fn(arg); } finally { vi.unstubAllGlobals(); }
    };
    expect([run(false, false), run(true, false), run(false, true)]).toEqual([false, true, true]);
  });

  it('fails on an attribute with an EMPTY value, by count, rather than printing a page that is not ready', async () => {
    launchMock.mockResolvedValue(makeBrowser(null, [
      { attrs: [{ name: 'data-print-error-fonts', value: '' }], ready: false },
    ]));
    await expect(playwrightTransport.render(request)).rejects.toThrow(/cannot render: no reason given$/);
  });

  it('waits again when the attribute was cleared and the page is not yet ready', async () => {
    waitCalls.length = 0;
    launchMock.mockResolvedValue(makeBrowser(null, [
      { attrs: [], ready: false },
      { attrs: [], ready: true },
    ]));
    await expect(playwrightTransport.render(request)).resolves.toBeInstanceOf(Buffer);
    expect(waitCalls).toHaveLength(2);
  });

  describe('the deadline', () => {
    beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-30T10:00:00Z')); waitCalls.length = 0; });
    afterEach(() => { vi.useRealTimers(); setDuringWait(null); });

    it('gives up, saying so, when the page is neither ready nor failed within the timeout', async () => {
      // Each wait "resolves" only after it has used its whole timeout.
      setDuringWait((timeout) => vi.setSystemTime(Date.now() + timeout));
      launchMock.mockResolvedValue(makeBrowser(null, [{ attrs: [], ready: false }]));
      await expect(playwrightTransport.render(request)).rejects.toThrow(/neither ready nor failed within the timeout/);
      expect(waitCalls).toHaveLength(1);
    });

    it('re-waits for at most the time left to the ORIGINAL deadline', async () => {
      const { PRINT_READY_TIMEOUT_MS } = await import('@/lib/pdf/pdfTransport');
      const spent = 12_000;
      setDuringWait((() => {
        let n = 0;
        return () => { if (n++ === 0) vi.setSystemTime(Date.now() + spent); };
      })());
      launchMock.mockResolvedValue(makeBrowser(null, [{ attrs: [], ready: false }, { attrs: [], ready: true }]));
      await playwrightTransport.render(request);
      expect(waitCalls).toHaveLength(2);
      expect(waitCalls[0]!.timeout).toBe(PRINT_READY_TIMEOUT_MS);
      expect(waitCalls[1]!.timeout).toBe(PRINT_READY_TIMEOUT_MS - spent);
    });
  });

  it('renders normally when the page reports nothing', async () => {
    launchMock.mockResolvedValue(makeBrowser(null));
    await expect(playwrightTransport.render(request)).resolves.toBeInstanceOf(Buffer);
  });
});

