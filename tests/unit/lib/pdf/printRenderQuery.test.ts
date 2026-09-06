import { describe, it, expect } from 'vitest';
import { isPrintRenderQuery } from '@/lib/pdf/printRenderQuery';

describe('isPrintRenderQuery', () => {
  it('is true for ?print=1, the exact signal report-packs.tsx branches on', () => {
    expect(isPrintRenderQuery({ print: '1' })).toBe(true);
  });

  it('is false with no print param', () => {
    expect(isPrintRenderQuery({})).toBe(false);
  });

  it('is false for any value other than the string "1"', () => {
    expect(isPrintRenderQuery({ print: '0' })).toBe(false);
    expect(isPrintRenderQuery({ print: 'true' })).toBe(false);
  });

  it('is false when print is an array (repeated query param)', () => {
    expect(isPrintRenderQuery({ print: ['1', '1'] })).toBe(false);
  });

  it('ignores unrelated query params', () => {
    expect(isPrintRenderQuery({ pack: 'management', from: '2026-01-01', print: '1' })).toBe(true);
  });
});
