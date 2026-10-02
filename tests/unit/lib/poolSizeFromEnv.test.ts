/**
 * R-182: every pool's size is read through one validated reader. pg-pool already
 * turns NaN and 0 into 10 (see pgPoolMaxPremise.test.ts); the real dangers were
 * a huge or Infinity value and a negative one. An invalid value gives
 * min(default, 10), so a typo never makes a pool bigger than before.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn, error: vi.fn() } }));

import { poolSizeFromEnv, authPoolMax, DEFAULT_AUTH_POOL_MAX } from '@/lib/limits/poolLimits';

const NAME = 'R182_TEST_POOL_MAX';

describe('poolSizeFromEnv (R-182)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    warn.mockReset();
  });

  it('returns the default, silently, when unset or blank', () => {
    vi.stubEnv(NAME, undefined as unknown as string);
    expect(poolSizeFromEnv(NAME, 7)).toBe(7);
    vi.stubEnv(NAME, '');
    expect(poolSizeFromEnv(NAME, 7)).toBe(7);
    vi.stubEnv(NAME, '   ');
    expect(poolSizeFromEnv(NAME, 7)).toBe(7);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([['1', 1], ['3', 3], ['25', 25], ['100', 100], [' 7 ', 7]])('takes a valid value: %j', (raw, expected) => {
    vi.stubEnv(NAME, raw);
    expect(poolSizeFromEnv(NAME, 20)).toBe(expected);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['0', '-2', '-0', '2.5', '1.0', '101', '1000000', 'abc', '12abc', 'NaN', 'Infinity', '-Infinity',
    '0x10', '0b11', '0o7', '1e1', '1E2', '10.0', '+5', '5_0', '٣'])('gives min(default, 10), with one warning, for %j', (raw) => {
    vi.stubEnv(NAME, raw);
    expect(poolSizeFromEnv(NAME, 20)).toBe(10);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toMatchObject({ name: NAME, value: raw, default: 20, using: 10 });
  });

  it('a default below 10 is kept for an invalid value (never bigger than the default)', () => {
    vi.stubEnv(NAME, 'abc');
    expect(poolSizeFromEnv(NAME, 5)).toBe(5);
  });

  it('warns once per (name, value), not on every call', () => {
    vi.stubEnv(NAME, 'once-only');
    for (let i = 0; i < 5; i++) expect(poolSizeFromEnv(NAME, 20)).toBe(10);
    expect(warn).toHaveBeenCalledTimes(1);
    vi.stubEnv(NAME, 'another');
    poolSizeFromEnv(NAME, 20);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('truncates a long value in the log', () => {
    const long = 'x'.repeat(500);
    vi.stubEnv(NAME, long);
    poolSizeFromEnv(NAME, 20);
    const logged = String((warn.mock.calls[0]![1] as { value: string }).value);
    expect(logged.length).toBeLessThan(60);
    expect(logged.startsWith('x'.repeat(40))).toBe(true);
  });

  it('logs under the category the caller names', () => {
    vi.stubEnv(NAME, 'cat-test');
    poolSizeFromEnv(NAME, 20, 'rateLimit');
    expect(warn.mock.calls[0]![2]).toBe('rateLimit');
  });

  it('authPoolMax is validated and keeps its default of 20', () => {
    expect(DEFAULT_AUTH_POOL_MAX).toBe(20);
    vi.stubEnv('AUTH_POOL_MAX', undefined as unknown as string);
    expect(authPoolMax()).toBe(20);
    vi.stubEnv('AUTH_POOL_MAX', '8');
    expect(authPoolMax()).toBe(8);
    vi.stubEnv('AUTH_POOL_MAX', 'twenty');
    expect(authPoolMax()).toBe(10);
    vi.stubEnv('AUTH_POOL_MAX', '0');
    expect(authPoolMax()).toBe(10);
  });
});
