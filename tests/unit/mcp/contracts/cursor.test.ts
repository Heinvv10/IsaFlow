import { describe, expect, it } from 'vitest';
import { compareCursorKeys, decodeCursor, encodeCursor } from '@/lib/mcp/contracts/cursor';

describe('cursor', () => {
  it('round-trips a key', () => {
    const key = { parts: ['2026-09-03', 'a1b2'] };
    expect(decodeCursor(encodeCursor(key), 2)).toEqual(key);
  });

  it('rejects a cursor with the wrong number of parts', () => {
    expect(decodeCursor(encodeCursor({ parts: ['a'] }), 2)).toBeNull();
  });

  it('rejects junk rather than throwing inside a savepoint-less read', () => {
    expect(decodeCursor('not-a-cursor', 2)).toBeNull();
    expect(decodeCursor('', 1)).toBeNull();
    expect(decodeCursor('x'.repeat(600), 1)).toBeNull();
  });

  it('rejects a cursor whose parts are not all strings', () => {
    const forged = Buffer.from(JSON.stringify(['a', 3]), 'utf8').toString('base64url');
    expect(decodeCursor(forged, 2)).toBeNull();
  });

  it('refuses an empty or over-long key at encode time', () => {
    expect(() => encodeCursor({ parts: [] })).toThrow();
    expect(() => encodeCursor({ parts: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })).toThrow();
  });

  it('orders by each part in turn, most significant first', () => {
    expect(compareCursorKeys({ parts: ['1000', 'a'] }, { parts: ['1100', 'a'] })).toBeLessThan(0);
    expect(compareCursorKeys({ parts: ['1100', 'a'] }, { parts: ['1100', 'b'] })).toBeLessThan(0);
    expect(compareCursorKeys({ parts: ['1100', 'b'] }, { parts: ['1100', 'b'] })).toBe(0);
    expect(compareCursorKeys({ parts: ['1200', 'a'] }, { parts: ['1100', 'z'] })).toBeGreaterThan(0);
  });
});
