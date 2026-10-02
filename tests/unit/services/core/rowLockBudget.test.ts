/**
 * core/rowLockBudget.withRowLockBudget — the one bounded wait every D8 reversal-flow row lock runs under
 * (D8 round 9). Real-ledger proof: tests/integration/d8-r9-lock-budget.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { tx } = vi.hoisted(() => ({
  tx: { client: null as null | { query: ReturnType<typeof vi.fn> }, queries: [] as string[] },
}));
vi.mock('@/lib/als', () => ({
  als: { getStore: () => (tx.client ? { client: tx.client } : undefined) },
  assertTxUsable: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { RowLockTimeoutError, withRowLockBudget } from '@/modules/accounting/services/core/rowLockBudget';

function client(previous = '17s') {
  return {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      tx.queries.push(params ? `${text} ${JSON.stringify(params)}` : text);
      return { rows: [{ v: previous }] };
    }),
  };
}
const timeout = () => new RowLockTimeoutError('Invoice i-1');

beforeEach(() => { tx.queries = []; tx.client = client(); });

describe('withRowLockBudget', () => {
  it('sets the remaining budget, runs the lock, and restores the caller\'s value', async () => {
    expect(await withRowLockBudget(async () => 'locked', timeout)).toBe('locked');
    expect(tx.queries[0]).toMatch(/current_setting\('lock_timeout'\)/);
    expect(tx.queries[1]).toMatch(/set_config\('lock_timeout', \$1, true\) \["(4\d{3}|5000)ms"\]/);
    expect(tx.queries[2]).toBe(`SELECT set_config('lock_timeout', $1, true) ["17s"]`);
  });

  it('maps a 55P03 to the caller\'s typed error and leaves the aborted transaction alone', async () => {
    const err = await withRowLockBudget(async () => { throw Object.assign(new Error('lock'), { code: '55P03' }); }, timeout)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RowLockTimeoutError);
    expect(tx.queries).toHaveLength(2); // no restore: a statement on an aborted transaction would raise 25P02
  });

  it('restores the setting when the lock body refuses without a Postgres error, and keeps the refusal', async () => {
    const refusal = new Error('broken chain');
    await expect(withRowLockBudget(async () => { throw refusal; }, timeout)).rejects.toBe(refusal);
    expect(tx.queries[2]).toBe(`SELECT set_config('lock_timeout', $1, true) ["17s"]`);
  });

  it('a spent deadline refuses before taking anything', async () => {
    const fn = vi.fn();
    await expect(withRowLockBudget(fn, timeout, { deadline: Date.now() - 1 })).rejects.toBeInstanceOf(RowLockTimeoutError);
    expect(fn).not.toHaveBeenCalled();
    expect(tx.queries).toHaveLength(0);
  });

  it('a shared deadline sets only what is left of it', async () => {
    await withRowLockBudget(async () => null, timeout, { deadline: Date.now() + 1200 });
    const ms = Number(/\["(\d+)ms"\]/.exec(tx.queries[1]!)![1]);
    expect(ms).toBeGreaterThan(1000);
    expect(ms).toBeLessThanOrEqual(1200);
  });

  it('outside a request transaction runs the body as it was — there is no lock to bound', async () => {
    tx.client = null;
    expect(await withRowLockBudget(async () => 7, timeout)).toBe(7);
  });
});
