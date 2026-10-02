/**
 * R-182: every pool's size is read through one validated reader. pg-pool already
 * turns NaN and 0 into 10 (see pgPoolMaxPremise.test.ts); the real dangers were
 * a huge or Infinity value and a negative one. What holds for an invalid value:
 * min(default, 10, ceil(Number(text))) when Number(text) is finite and > 0, else
 * min(default, 10), so no spelling the old Number() accepted gives a pool with
 * more connections than pg-pool allowed for it.
 *
 * The reader remembers which (name, value) it has warned about for the life of
 * the module. Each warning case below therefore uses a (name, value) pair no
 * other case in this file uses (the `_B` and `_C` names exist for that), so the
 * assertions do not depend on order. Checked with --sequence.shuffle.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn, error: vi.fn() } }));

import { poolSizeFromEnv, authPoolMax, DEFAULT_AUTH_POOL_MAX, MIN_AUTH_POOL_MAX, MIN_PG_POOL_MAX } from '@/lib/limits/poolLimits';

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

  // [spelling, size with a default of 20]. A spelling Number() read as a usable
  // size gives min(20, 10, ceil(that size)); anything else gives 10.
  it.each([
    ['5.0', 5], ['+5', 5], ['0x5', 5], ['1.0', 1], ['2.5', 3], ['0.5', 1], ['0o7', 7], ['0b11', 3],
    ['1e1', 10], ['10.0', 10], ['0x10', 10], ['1E2', 10], ['101', 10], ['1000000', 10],
    ['0', 10], ['-2', 10], ['-0', 10], ['abc', 10], ['12abc', 10], ['NaN', 10], ['Infinity', 10],
    ['-Infinity', 10], ['5_0', 10], ['٣', 10],
  ])('invalid %j gives %j, with one warning', (raw, expected) => {
    vi.stubEnv(NAME, raw);
    expect(poolSizeFromEnv(NAME, 20)).toBe(expected);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toMatchObject({ name: NAME, default: 20, using: expected });
  });

  it('is never bigger than the default, even when the spelling asks for more', () => {
    vi.stubEnv(`${NAME}_B`, '0x5');
    expect(poolSizeFromEnv(`${NAME}_B`, 3)).toBe(3);
    vi.stubEnv(`${NAME}_B`, 'abc');
    expect(poolSizeFromEnv(`${NAME}_B`, 5)).toBe(5);
  });

  it('warns once per (name, value), not on every call', () => {
    vi.stubEnv(NAME, 'once-only');
    for (let i = 0; i < 5; i++) expect(poolSizeFromEnv(NAME, 20)).toBe(10);
    expect(warn).toHaveBeenCalledTimes(1);
    vi.stubEnv(NAME, 'another');
    poolSizeFromEnv(NAME, 20);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('never logs the value: a pasted connection string keeps its password out of the log', () => {
    const password = 'fixture-only-pw-7731'; // an invented value, not a credential
    const dsn = `postgresql://app_user:${password}@db.internal:5432/isaflow`;
    vi.stubEnv(NAME, dsn);
    expect(poolSizeFromEnv(NAME, 20)).toBe(10);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls[0]);
    expect(logged).not.toContain(password);
    expect(logged).not.toContain('app_user');
    expect(warn.mock.calls[0]![1]).toMatchObject({ name: NAME, length: dsn.length, digitsOnly: false });
  });

  it('records that a value was digits only (a number out of range)', () => {
    vi.stubEnv(NAME, '4242');
    poolSizeFromEnv(NAME, 20);
    expect(warn.mock.calls[0]![1]).toMatchObject({ length: 4, digitsOnly: true });
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
    vi.stubEnv('AUTH_POOL_MAX', '6.0');
    expect(authPoolMax()).toBe(6);
  });

  it.each(['1', '1.0', '0.5', '+1'])('AUTH_POOL_MAX %j is raised to the minimum of 2, with a warning', (raw) => {
    vi.stubEnv('AUTH_POOL_MAX', raw);
    expect(authPoolMax()).toBe(MIN_AUTH_POOL_MAX);
    expect(MIN_AUTH_POOL_MAX).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('AUTH_POOL_MAX 2 is taken as given, silently', () => {
    vi.stubEnv('AUTH_POOL_MAX', '2');
    expect(authPoolMax()).toBe(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a minimum applies to the reader as well', () => {
    vi.stubEnv(NAME, '3');
    expect(poolSizeFromEnv(NAME, 20, 'pool', 5)).toBe(5);
  });

  it('a minimum above the default or above 10 cannot give a pool bigger than either', () => {
    vi.stubEnv(`${NAME}_C`, '3');
    expect(poolSizeFromEnv(`${NAME}_C`, 20, 'pool', 50)).toBe(10);
    expect(poolSizeFromEnv(`${NAME}_C`, 4, 'pool', 50)).toBe(4);
    vi.stubEnv(`${NAME}_C`, 'abc');
    expect(poolSizeFromEnv(`${NAME}_C`, 4, 'pool', 50)).toBe(4);
    expect(poolSizeFromEnv(`${NAME}_C`, 20, 'pool', 50)).toBe(10);
  });

  it('PG_POOL_MAX floor is 2', () => {
    expect(MIN_PG_POOL_MAX).toBe(2);
  });

  it("'50.0' gives 10 while '50' gives 50", () => {
    vi.stubEnv(NAME, '50');
    expect(poolSizeFromEnv(NAME, 20)).toBe(50);
    vi.stubEnv(NAME, '50.0');
    expect(poolSizeFromEnv(NAME, 20)).toBe(10);
  });
});
