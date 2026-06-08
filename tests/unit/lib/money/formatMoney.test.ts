import { describe, it, expect } from 'vitest';
import { formatMoney } from '@/lib/money/formatMoney';

describe('formatMoney', () => {
  it('formats a positive amount with the R symbol and thousands separators', () => {
    expect(formatMoney(318400)).toBe('R 318,400.00');
  });

  it('formats negatives with a leading minus before the symbol', () => {
    expect(formatMoney(-2300)).toBe('-R 2,300.00');
  });

  it('rounds to two decimals', () => {
    expect(formatMoney(42100.5)).toBe('R 42,100.50');
  });

  it('can omit decimals when asked', () => {
    expect(formatMoney(1200000, { decimals: 0 })).toBe('R 1,200,000');
  });

  it('renders zero cleanly', () => {
    expect(formatMoney(0)).toBe('R 0.00');
  });

  // Non-finite inputs are pinned, not fixed: toFixed() yields "NaN"/"Infinity"
  // (no decimal point), so the fracPart guard skips the dot and keeps these clean.
  // We document this real output rather than mask an upstream bug — callers
  // pass typed finite numbers; this is the cost of feeding garbage in.
  it('passes NaN through verbatim (caller responsibility)', () => {
    expect(formatMoney(NaN)).toBe('R NaN');
  });

  it('passes Infinity through verbatim (caller responsibility)', () => {
    expect(formatMoney(Infinity)).toBe('R Infinity');
  });
});
