/**
 * R-175: the limiter pool's size comes from RATE_LIMIT_POOL_MAX (default 10),
 * like the other pools, so it can be lowered without a deploy. An invalid value
 * (R-182: through the shared poolSizeFromEnv) gives min(default, 10,
 * ceil(Number(text))) when Number(text) is finite and above 0, else
 * min(default, 10); the cases below with a value of 10 or more give the default.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn, error: vi.fn() } }));

import { DEFAULT_RATE_LIMIT_POOL_MAX, rateLimitPoolMax } from '@/lib/rateLimitPool';

describe('RATE_LIMIT_POOL_MAX (R-175)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    warn.mockReset();
  });

  it('defaults to 10 when unset or empty', () => {
    vi.stubEnv('RATE_LIMIT_POOL_MAX', undefined as unknown as string);
    expect(rateLimitPoolMax()).toBe(10);
    vi.stubEnv('RATE_LIMIT_POOL_MAX', '  ');
    expect(rateLimitPoolMax()).toBe(10);
    expect(DEFAULT_RATE_LIMIT_POOL_MAX).toBe(10);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([['1', 1], ['3', 3], ['25', 25], ['100', 100], [' 7 ', 7]])('takes a valid value: %j', (raw, expected) => {
    vi.stubEnv('RATE_LIMIT_POOL_MAX', raw);
    expect(rateLimitPoolMax()).toBe(expected);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['abc', '0', '-2', '101', '1e9', 'NaN', 'Infinity'])('falls back to 10, with a warning, for %j', (raw) => {
    vi.stubEnv('RATE_LIMIT_POOL_MAX', raw);
    expect(rateLimitPoolMax()).toBe(10);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toMatchObject({ name: 'RATE_LIMIT_POOL_MAX', default: 10, using: 10 });
    expect(warn.mock.calls[0]![2]).toBe('rateLimit');
  });

  it.each([['2.5', 3], ['5.0', 5], ['+5', 5], ['1e1', 10]])('%j is no longer taken as given: it gives %j (R-182)', (raw, expected) => {
    vi.stubEnv('RATE_LIMIT_POOL_MAX', raw);
    expect(rateLimitPoolMax()).toBe(expected);
  });

  it('the pool is built with the configured size', async () => {
    vi.resetModules();
    vi.stubEnv('RATE_LIMIT_POOL_MAX', '4');
    vi.stubEnv('DATABASE_URL', 'postgresql://127.0.0.1:1/none');
    const { getRateLimitPool } = await import('@/lib/rateLimitPool');
    const pool = getRateLimitPool();
    expect(pool.options.max).toBe(4);
    await pool.end();
  });
});
