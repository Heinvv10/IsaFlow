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
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { log } from '@/lib/logger';
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

/** As `client`, but the restore is answered by Postgres with `code` (25P02: the transaction is aborted). */
function clientRestoreFails(code: string) {
  const c = client();
  const ok = c.query.getMockImplementation()!;
  c.query.mockImplementation(async (text: string, params?: unknown[]) => {
    if (tx.queries.length >= 2 && /set_config/.test(text)) {
      tx.queries.push(`${text} ${JSON.stringify(params)}`);
      throw Object.assign(new Error('restore refused'), { code });
    }
    return ok(text, params);
  });
  return c;
}

beforeEach(() => { tx.queries = []; tx.client = client(); vi.mocked(log.error).mockClear(); vi.mocked(log.debug).mockClear(); });

describe('withRowLockBudget', () => {
  it('sets the remaining budget, runs the lock, and restores the caller\'s value', async () => {
    expect(await withRowLockBudget(async () => 'locked', timeout)).toBe('locked');
    expect(tx.queries[0]).toMatch(/current_setting\('lock_timeout'\)/);
    expect(tx.queries[1]).toMatch(/set_config\('lock_timeout', \$1, true\) \["(4\d{3}|5000)ms"\]/);
    expect(tx.queries[2]).toBe(`SELECT set_config('lock_timeout', $1, true) ["17s"]`);
  });

  it('maps a 55P03 to the caller\'s typed error; the restore\'s 25P02 on the aborted transaction is expected, not an error', async () => {
    tx.client = clientRestoreFails('25P02');
    const err = await withRowLockBudget(async () => { throw Object.assign(new Error('lock'), { code: '55P03' }); }, timeout)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RowLockTimeoutError);
    expect(tx.queries).toHaveLength(3); // the restore is attempted
    expect(log.error).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledTimes(1);
  });

  // D8 round 11 (rev-d8-c553cc0f8 F3): a Postgres error an inner savepoint rolled back leaves the transaction
  // usable — the restore skipped on "any PG-coded failure" left the budget's '5s' in force for the caller.
  it('restores the caller\'s value after a Postgres error that an inner savepoint already rolled back', async () => {
    const pgErr = Object.assign(new Error('division by zero'), { code: '22012' });
    await expect(withRowLockBudget(async () => { throw pgErr; }, timeout)).rejects.toBe(pgErr);
    expect(tx.queries[2]).toBe(`SELECT set_config('lock_timeout', $1, true) ["17s"]`);
  });

  // F4: a nested helper's typed timeout reaches the outer budget with the transaction aborted. Its restore's
  // 25P02 is expected contention, not an ERROR event.
  it('a typed refusal on an aborted transaction: the refusal stands, the 25P02 is logged at debug only', async () => {
    tx.client = clientRestoreFails('25P02');
    const refusal = Object.assign(new Error('Bank transaction b-1 is being allocated'), { code: 'BANK_TX_LOCK_TIMEOUT' });
    await expect(withRowLockBudget(async () => { throw refusal; }, timeout)).rejects.toBe(refusal);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledTimes(1);
  });

  it('any other restore failure after a refusal is still an error, and the refusal stands', async () => {
    tx.client = clientRestoreFails('08006');
    const refusal = new Error('broken chain');
    await expect(withRowLockBudget(async () => { throw refusal; }, timeout)).rejects.toBe(refusal);
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('a restore failure with no refusal to keep is thrown', async () => {
    tx.client = clientRestoreFails('25P02');
    await expect(withRowLockBudget(async () => 'locked', timeout)).rejects.toMatchObject({ code: '25P02' });
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
