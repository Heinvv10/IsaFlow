import { describe, it, expect, afterEach, vi } from 'vitest';
import { isPrintRender } from '@/lib/pdf/printRenderQuery';

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
      expect(isPrintRender({ isReady: true, query: { print: '1' } })).toBe(true);
    });

    it('is false with no print param', () => {
      expect(isPrintRender({ isReady: true, query: {} })).toBe(false);
    });

    it('is false for any value other than the string "1"', () => {
      expect(isPrintRender({ isReady: true, query: { print: '0' } })).toBe(false);
      expect(isPrintRender({ isReady: true, query: { print: 'true' } })).toBe(false);
    });

    it('is false when print is an array (repeated query param)', () => {
      expect(isPrintRender({ isReady: true, query: { print: ['1', '1'] } })).toBe(false);
    });

    it('ignores unrelated query params', () => {
      expect(
        isPrintRender({ isReady: true, query: { pack: 'management', from: '2026-01-01', print: '1' } }),
      ).toBe(true);
    });
  });

  describe('before the router is ready (query is still {} on the first client render)', () => {
    it('falls back to the live URL and is true when it carries print=1', () => {
      vi.stubGlobal('window', { location: { search: '?pack=management&print=1' } });
      expect(isPrintRender({ isReady: false, query: {} })).toBe(true);
    });

    it('falls back to the live URL and is false when it does not', () => {
      vi.stubGlobal('window', { location: { search: '?pack=management' } });
      expect(isPrintRender({ isReady: false, query: {} })).toBe(false);
    });

    it('is false for a print value other than "1" in the live URL', () => {
      vi.stubGlobal('window', { location: { search: '?print=0' } });
      expect(isPrintRender({ isReady: false, query: {} })).toBe(false);
    });

    it('ignores a stale populated query and reads the URL instead', () => {
      vi.stubGlobal('window', { location: { search: '?print=1' } });
      expect(isPrintRender({ isReady: false, query: { print: '0' } })).toBe(true);
    });

    it('is false on the server, where there is no window to read', () => {
      vi.stubGlobal('window', undefined);
      expect(isPrintRender({ isReady: false, query: {} })).toBe(false);
    });
  });
});
