import { describe, it, expect, afterEach, vi } from 'vitest';
import { isPrintRender, PRINT_RENDER_PATH } from '@/lib/pdf/printRenderQuery';

/**
 * `isPrintRender` decides whether a page mount is a PDF print render. Two
 * consumers branch on it: `report-packs.tsx`'s dispatcher (print page vs
 * interactive screen) and `_app.tsx`'s provider gate. Getting `false` wrong
 * for even one render pass lets `AuthProvider` fire `/api/auth/me`, whose
 * handler clears the cookie carrying the print token — so the not-ready
 * window matters as much as the ready one.
 */
describe('isPrintRender', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('once the router is ready', () => {
    it('is true for ?print=1, the exact signal report-packs.tsx branches on', () => {
      expect(isPrintRender({ isReady: true, pathname: PRINT_RENDER_PATH, query: { print: '1' } })).toBe(true);
    });

    it('is false with no print param', () => {
      expect(isPrintRender({ isReady: true, pathname: PRINT_RENDER_PATH, query: {} })).toBe(false);
    });

    it('is false for any value other than the string "1"', () => {
      expect(isPrintRender({ isReady: true, pathname: PRINT_RENDER_PATH, query: { print: '0' } })).toBe(false);
      expect(isPrintRender({ isReady: true, pathname: PRINT_RENDER_PATH, query: { print: 'true' } })).toBe(false);
    });

    it('is false when print is an array (repeated query param)', () => {
      expect(isPrintRender({ isReady: true, pathname: PRINT_RENDER_PATH, query: { print: ['1', '1'] } })).toBe(false);
    });

    it('ignores unrelated query params', () => {
      expect(
        isPrintRender({ isReady: true, pathname: PRINT_RENDER_PATH, query: { pack: 'management', from: '2026-01-01', print: '1' } }),
      ).toBe(true);
    });
  });

  describe('before the router is ready (query is still {} on the first client render)', () => {
    it('falls back to the live URL and is true when it carries print=1', () => {
      vi.stubGlobal('window', { location: { pathname: PRINT_RENDER_PATH, search: '?pack=management&print=1' } });
      expect(isPrintRender({ isReady: false, pathname: PRINT_RENDER_PATH, query: {} })).toBe(true);
    });

    it('falls back to the live URL and is false when it does not', () => {
      vi.stubGlobal('window', { location: { pathname: PRINT_RENDER_PATH, search: '?pack=management' } });
      expect(isPrintRender({ isReady: false, pathname: PRINT_RENDER_PATH, query: {} })).toBe(false);
    });

    it('is false for a print value other than "1" in the live URL', () => {
      vi.stubGlobal('window', { location: { pathname: PRINT_RENDER_PATH, search: '?print=0' } });
      expect(isPrintRender({ isReady: false, pathname: PRINT_RENDER_PATH, query: {} })).toBe(false);
    });

    it('ignores a stale populated query and reads the URL instead', () => {
      vi.stubGlobal('window', { location: { pathname: PRINT_RENDER_PATH, search: '?print=1' } });
      expect(isPrintRender({ isReady: false, pathname: PRINT_RENDER_PATH, query: { print: '0' } })).toBe(true);
    });

    it('is false on the server, where there is no window to read', () => {
      vi.stubGlobal('window', undefined);
      expect(isPrintRender({ isReady: false, pathname: PRINT_RENDER_PATH, query: {} })).toBe(false);
    });
  });
});

/**
 * ADVERSARIAL INFO-1 / re-review: the gate used to be global on `?print=1`.
 * `print` is not a reserved parameter — any page could carry one for its own
 * reasons — and a global gate strips that page's auth and company context with
 * no error to show for it. Only the pack page has a print branch.
 */
describe('isPrintRender — scoped to the page the PDF pipeline renders', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('is false for another page carrying ?print=1, router ready', () => {
    expect(isPrintRender({ isReady: true, pathname: '/accounting/reports/trial-balance', query: { print: '1' } })).toBe(false);
    expect(isPrintRender({ isReady: true, pathname: '/accounting/invoices', query: { print: '1' } })).toBe(false);
  });

  it('is false for another page carrying ?print=1 before the router is ready', () => {
    vi.stubGlobal('window', { location: { pathname: '/accounting/invoices', search: '?print=1' } });
    expect(isPrintRender({ isReady: false, pathname: '/accounting/invoices', query: {} })).toBe(false);
  });

  it('is still true on the pack page itself, both before and after ready', () => {
    expect(isPrintRender({ isReady: true, pathname: PRINT_RENDER_PATH, query: { print: '1' } })).toBe(true);
    vi.stubGlobal('window', { location: { pathname: PRINT_RENDER_PATH, search: '?print=1' } });
    expect(isPrintRender({ isReady: false, pathname: PRINT_RENDER_PATH, query: {} })).toBe(true);
  });

  it('is false on the pack page without the print flag', () => {
    expect(isPrintRender({ isReady: true, pathname: PRINT_RENDER_PATH, query: {} })).toBe(false);
  });
});
