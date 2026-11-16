// The payload hash decides "the same request": it must not depend on how the client ordered the keys, and it must
// depend on every value (bank WP2 row 7).
import { describe, expect, it } from 'vitest';
import { canonical, payloadHashOf } from '@/lib/idempotency/withHttpIdempotency';

describe('payloadHashOf', () => {
  it('ignores key order at every depth', () => {
    expect(payloadHashOf({ a: 1, b: { c: 2, d: [{ x: 1, y: 2 }] } })).toBe(payloadHashOf({ b: { d: [{ y: 2, x: 1 }], c: 2 }, a: 1 }));
    expect(canonical({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('depends on array order, values and types', () => {
    expect(payloadHashOf({ l: [1, 2] })).not.toBe(payloadHashOf({ l: [2, 1] }));
    expect(payloadHashOf({ amount: 100 })).not.toBe(payloadHashOf({ amount: 101 }));
    expect(payloadHashOf({ amount: 100 })).not.toBe(payloadHashOf({ amount: '100' }));
    expect(payloadHashOf({ a: { b: 1 } })).not.toBe(payloadHashOf({ a: {}, b: 1 }));
  });

  it('drops undefined fields (JSON would) but keeps null', () => {
    expect(payloadHashOf({ a: 1, b: undefined })).toBe(payloadHashOf({ a: 1 }));
    expect(payloadHashOf({ a: 1, b: null })).not.toBe(payloadHashOf({ a: 1 }));
  });
});
