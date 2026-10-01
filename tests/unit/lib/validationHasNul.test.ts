import { describe, it, expect } from 'vitest';
import { hasNul } from '@/lib/validation';

const nest = (depth: number, leaf: unknown) => { let v: unknown = leaf; for (let i = 0; i < depth; i += 1) v = { k: v }; return v; };

describe('hasNul', () => {
  it('finds a NUL in a string, array element, nested value, and in an object KEY', () => {
    expect(hasNul('a\u0000b')).toBe(true);
    expect(hasNul(['ok', 'x\u0000'])).toBe(true);
    expect(hasNul({ a: { b: ['c\u0000'] } })).toBe(true);
    expect(hasNul({ ['bad\u0000key']: 'fine' })).toBe(true);
  }, 5000);

  it('passes clean input, including primitives and null', () => {
    expect(hasNul({ a: 'x', b: [1, 2, { c: null }], d: true })).toBe(false);
    expect(hasNul(null)).toBe(false);
    expect(hasNul(42)).toBe(false);
  }, 5000);

  it('refuses (true) input nested deeper than it will look, instead of passing it', () => {
    expect(hasNul(nest(6, 'clean'))).toBe(false);
    expect(hasNul(nest(40, 'clean'))).toBe(true);
    expect(hasNul(nest(40, 'x\u0000'))).toBe(true);
  }, 5000);

  it('is bounded and non-throwing on a cyclic object and on a very wide one', () => {
    const cyc: Record<string, unknown> = { a: 'x' };
    cyc.self = cyc;
    expect(() => hasNul(cyc)).not.toThrow();
    const wide = Array.from({ length: 150000 }, () => 'x');
    const t0 = Date.now();
    expect(hasNul(wide)).toBe(true);           // too large to vouch for
    expect(Date.now() - t0).toBeLessThan(1000);
  }, 5000);
});
