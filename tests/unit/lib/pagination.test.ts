/**
 * P3.4 (A–Z Phase 3): pagination caps for unbounded list endpoints.
 *
 * clampLimit/parsePagination guard every capped GET list endpoint — the June
 * audit found ~15 endpoints selecting entire large tables (worst: full
 * invoice-history GROUP BY). The helper must be impossible to talk out of
 * its cap via query-string creativity.
 */

import { describe, it, expect } from 'vitest';
import { clampLimit, parsePagination } from '@/lib/pagination';

describe('clampLimit', () => {
  it('returns the default when the value is missing', () => {
    expect(clampLimit(undefined)).toBe(50);
    expect(clampLimit(null)).toBe(50);
    expect(clampLimit('')).toBe(50);
  });

  it('parses numeric strings (the query-string case)', () => {
    expect(clampLimit('25')).toBe(25);
    expect(clampLimit('500')).toBe(500);
  });

  it('caps values above max', () => {
    expect(clampLimit('10000')).toBe(500);
    expect(clampLimit(99999)).toBe(500);
    expect(clampLimit('10000', 50, 200)).toBe(200);
  });

  it('falls back to the default for garbage, negatives and zero', () => {
    expect(clampLimit('abc')).toBe(50);
    expect(clampLimit('-5')).toBe(50);
    expect(clampLimit('0')).toBe(50);
    expect(clampLimit(NaN)).toBe(50);
    expect(clampLimit(Infinity)).toBe(500); // over max → capped, not default
  });

  it('floors fractional values', () => {
    expect(clampLimit('12.9')).toBe(12);
  });

  it('takes the first element when the query param repeats (string[])', () => {
    expect(clampLimit(['30', '9999'])).toBe(30);
  });

  it('honours custom default and max', () => {
    expect(clampLimit(undefined, 100, 2000)).toBe(100);
    expect(clampLimit('1500', 100, 2000)).toBe(1500);
    expect(clampLimit('99999', 100, 2000)).toBe(2000);
  });
});

describe('parsePagination', () => {
  it('returns defaults for an empty query', () => {
    expect(parsePagination({})).toEqual({ limit: 50, offset: 0 });
  });

  it('reads limit and offset from a query object', () => {
    expect(parsePagination({ limit: '20', offset: '40' })).toEqual({ limit: 20, offset: 40 });
  });

  it('clamps limit and floors bad offsets to 0', () => {
    expect(parsePagination({ limit: '99999', offset: '-10' })).toEqual({ limit: 500, offset: 0 });
    expect(parsePagination({ limit: 'abc', offset: 'xyz' })).toEqual({ limit: 50, offset: 0 });
  });

  it('floors fractional offsets', () => {
    expect(parsePagination({ offset: '10.7' }).offset).toBe(10);
  });

  it('passes custom default/max through to the limit', () => {
    expect(parsePagination({}, 100, 2000).limit).toBe(100);
    expect(parsePagination({ limit: '5000' }, 100, 2000).limit).toBe(2000);
  });
});
