import { describe, it, expect, afterEach, vi } from 'vitest';
import { isPrintRender, PRINT_RENDER_PATH } from '@/lib/pdf/printRenderQuery';

/**
 * `isPrintRender` decides whether a page mount is a PDF print render. Two
 * consumers branch on it: `report-packs.tsx`'s dispatcher (print page vs
 * interactive screen) and `_app.tsx`'s provider gate. Getting `false` wrong
 * for even one render pass lets `AuthProvider` fire `/api/auth/me`, whose
 * handler clears the cookie carrying the print token.
 *
 * There is no `window.location` fallback for a not-ready router any more: the
 * pack page has `getServerSideProps`, so `router.isReady` is true from the
 * first client render and the window that fallback covered cannot occur.
 */
describe('isPrintRender', () => {
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

  describe('before the router is ready', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('is false: router.query is not yet the authority, and nothing else is consulted', () => {
      // The URL says print=1 as loudly as it can. It is not consulted: the
      // page this gate serves has getServerSideProps, so a not-ready router
      // cannot happen there, and a second source of truth for a state that
      // cannot occur is a branch nothing exercises.
      vi.stubGlobal('window', { location: { pathname: PRINT_RENDER_PATH, search: '?print=1' } });
      expect(isPrintRender({ isReady: false, pathname: PRINT_RENDER_PATH, query: { print: '1' } })).toBe(false);
      expect(isPrintRender({ isReady: false, pathname: PRINT_RENDER_PATH, query: {} })).toBe(false);
    });
  });
});

describe('isPrintRender — scoped to the page the PDF pipeline renders', () => {
  it('is false for another page carrying ?print=1', () => {
    expect(isPrintRender({ isReady: true, pathname: '/accounting/reports/trial-balance', query: { print: '1' } })).toBe(false);
    expect(isPrintRender({ isReady: true, pathname: '/accounting/invoices', query: { print: '1' } })).toBe(false);
  });

  it('is true on the pack page itself', () => {
    expect(isPrintRender({ isReady: true, pathname: PRINT_RENDER_PATH, query: { print: '1' } })).toBe(true);
  });

  it('is false on the pack page without the print flag', () => {
    expect(isPrintRender({ isReady: true, pathname: PRINT_RENDER_PATH, query: {} })).toBe(false);
  });
});
