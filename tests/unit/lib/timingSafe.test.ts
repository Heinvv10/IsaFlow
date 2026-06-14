import { describe, it, expect } from 'vitest';
import { timingSafeEqualStr } from '@/lib/timingSafe';

describe('timingSafeEqualStr', () => {
  it('returns true for equal strings', () => {
    expect(timingSafeEqualStr('s3cret-value-1234', 's3cret-value-1234')).toBe(true);
  });
  it('returns false for different strings', () => {
    expect(timingSafeEqualStr('s3cret-value-1234', 's3cret-value-9999')).toBe(false);
  });
  it('returns false for different lengths (no throw)', () => {
    expect(timingSafeEqualStr('short', 'a-much-longer-secret')).toBe(false);
  });
  it('handles empty inputs without throwing', () => {
    expect(timingSafeEqualStr('', '')).toBe(true);
    expect(timingSafeEqualStr('x', '')).toBe(false);
  });
});
