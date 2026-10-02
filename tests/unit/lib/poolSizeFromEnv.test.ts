/**
 * R-182: every pool's size is read through one validated reader. A `max` of NaN
 * leaves a pg pool never full, so a typo in an environment variable would make
 * a pool unbounded on a Postgres with max_connections 100.
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
    '0x10', '0b11', '0o7', '1e1', '1E2', '+5', '5_0', '٣'])('falls back to the default, with one warning, for %j', (raw) => {
    vi.stubEnv(NAME, raw);
    expect(poolSizeFromEnv(NAME, 20)).toBe(20);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toMatchObject({ name: NAME, value: raw, default: 20 });
  });

  it('authPoolMax is validated and keeps its default of 20', () => {
    expect(DEFAULT_AUTH_POOL_MAX).toBe(20);
    vi.stubEnv('AUTH_POOL_MAX', undefined as unknown as string);
    expect(authPoolMax()).toBe(20);
    vi.stubEnv('AUTH_POOL_MAX', '8');
    expect(authPoolMax()).toBe(8);
    vi.stubEnv('AUTH_POOL_MAX', 'twenty');
    expect(authPoolMax()).toBe(20);
    vi.stubEnv('AUTH_POOL_MAX', '0');
    expect(authPoolMax()).toBe(20);
  });
});
