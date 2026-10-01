/**
 * What the Playwright transport does when the print page reports it can never
 * become ready (`data-print-error-*`), and that it fails on the FIRST observed
 * error, as Gotenberg does. The browser double is shared with `playwrightTransport.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeBrowser, request, waitCalls } from './playwrightDouble';

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

  it('decides in ONE evaluation: errors win over ready, an empty value still counts, nothing is re-read', async () => {
    waitCalls.length = 0;
    launchMock.mockResolvedValue(makeBrowser(null));
    await playwrightTransport.render(request);
    expect(waitCalls).toHaveLength(1);
    const { fn, arg } = waitCalls[0]!;
    const run = (ready: boolean, attrs: Array<[string, string]>) => {
      vi.stubGlobal('document', {
        querySelector: () => (ready ? {} : null),
        documentElement: { attributes: attrs.map(([name, value]) => ({ name, value })) },
      });
      try { return fn(arg); } finally { vi.unstubAllGlobals(); }
    };
    expect(run(false, [['lang', 'en']])).toBe(false);
    expect(run(true, [['lang', 'en']])).toEqual({ ready: true, errors: [] });
    expect(run(false, [['data-print-error-pages', 'pages: HTTP 500']])).toEqual({ ready: false, errors: ['pages: HTTP 500'] });
    expect(run(true, [['data-print-error-fonts', 'fonts: x']])).toEqual({ ready: false, errors: ['fonts: x'] });
    expect(run(false, [['data-print-error-fonts', '']])).toEqual({ ready: false, errors: [''] });
  });

  it('fails on an attribute with an EMPTY value rather than printing a page that is not ready', async () => {
    launchMock.mockResolvedValue(makeBrowser(null, [
      { attrs: [{ name: 'data-print-error-fonts', value: '' }], ready: false },
    ]));
    await expect(playwrightTransport.render(request)).rejects.toThrow(/cannot render: no reason given$/);
  });

  it('fails on the FIRST observed error, even though it is withdrawn at the next poll and the page then becomes ready', async () => {
    launchMock.mockResolvedValue(makeBrowser(null, [
      { attrs: [{ name: 'data-print-error-pages', value: 'pages: HTTP 500' }], ready: false },
      { attrs: [], ready: true },
    ]));
    await expect(playwrightTransport.render(request)).rejects.toThrow(/cannot render: pages: HTTP 500$/);
  });

  it('fails on an error even when the ready marker is present beside it', async () => {
    launchMock.mockResolvedValue(makeBrowser(null, [
      { attrs: [{ name: 'data-print-error-fonts', value: 'fonts: x' }], ready: true },
    ]));
    await expect(playwrightTransport.render(request)).rejects.toThrow(/cannot render: fonts: x$/);
  });

  it('waits for the full print-ready timeout when the page is neither ready nor failed, then fails with the timeout', async () => {
    const { PRINT_READY_TIMEOUT_MS } = await import('@/lib/pdf/pdfTransport');
    waitCalls.length = 0;
    launchMock.mockResolvedValue(makeBrowser(null, [{ attrs: [], ready: false }]));
    await expect(playwrightTransport.render(request)).rejects.toThrow(/Timeout \d+ms exceeded/);
    expect(waitCalls).toHaveLength(1);
    expect(waitCalls[0]!.timeout).toBe(PRINT_READY_TIMEOUT_MS);
  });

  it('prints a page that becomes ready at a later poll with no error', async () => {
    launchMock.mockResolvedValue(makeBrowser(null, [{ attrs: [], ready: false }, { attrs: [], ready: true }]));
    await expect(playwrightTransport.render(request)).resolves.toBeInstanceOf(Buffer);
  });

  it('renders normally when the page reports nothing', async () => {
    launchMock.mockResolvedValue(makeBrowser(null));
    await expect(playwrightTransport.render(request)).resolves.toBeInstanceOf(Buffer);
  });
});

