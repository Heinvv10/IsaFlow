/**
 * Unit tests for bankRulesMatchingHelpers.toSqlPattern.
 *
 * The journal-line builder that used to live beside it is gone: the sweep
 * posts through the controlled bank allocation, whose plan builds the lines.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({
  sql: Object.assign(vi.fn(), { unsafe: vi.fn() }),
  transaction: vi.fn(),
  withTransaction: vi.fn(),
}));

import { toSqlPattern } from '@/modules/accounting/services/bank/bankRulesMatchingHelpers';

describe('toSqlPattern', () => {
  it('wraps for contains', () => expect(toSqlPattern('contains', 'foo')).toBe('%foo%'));
  it('appends for starts_with', () => expect(toSqlPattern('starts_with', 'foo')).toBe('foo%'));
  it('prepends for ends_with', () => expect(toSqlPattern('ends_with', 'foo')).toBe('%foo'));
  it('exact returns pattern', () => expect(toSqlPattern('exact', 'foo')).toBe('foo'));
  it('unknown falls back to contains', () => expect(toSqlPattern('weird', 'foo')).toBe('%foo%'));
});
