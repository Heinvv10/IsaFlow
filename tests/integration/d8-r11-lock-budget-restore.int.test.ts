/**
 * D8 round 11 (review rev-d8-c553cc0f8, findings 3 and 4): `restoreLockTimeout` guessed from the failure whether the
 * transaction was still usable, and guessed wrong both ways.
 *  F3 A Postgres error that an inner savepoint rolled back leaves the transaction usable, but the restore was skipped:
 *     the budget's '5s' stayed in force for the caller.
 *  F4 A nested helper's typed timeout (converted from 55P03) leaves the transaction aborted; the restore ran, got
 *     25P02, and logged an ERROR for ordinary contention.
 * The restore is now always attempted, and 25P02 is expected.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { RowLockTimeoutError, withRowLockBudget } from '@/modules/accounting/services/core/rowLockBudget';
import { BankTransactionLockTimeoutError, lockBankTransactionForUpdate } from '@/modules/accounting/services/bank/bankTxLock';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { runOn, seedBankTx } from './helpers/l1FifoFixture';
import { setup, teardown, type Ctx } from './d8-r4-helpers';

let c: Ctx;
type Row = Record<string, unknown>;
const setting = async () => String(((await sql`SELECT current_setting('lock_timeout') AS v`) as Row[])[0]!.v);
const outer = () => new RowLockTimeoutError('outer');

/** `fn` inside a request transaction that is rolled back afterwards. */
async function inRolledBackTx<T>(fn: () => Promise<T>): Promise<T> {
  const cl = await c.fx.pool.connect();
  try {
    await cl.query('BEGIN');
    return await runOn(c.fx, cl, fn);
  } finally {
    await cl.query('ROLLBACK');
    cl.release();
  }
}

describe.skipIf(!process.env.DATABASE_URL)('D8 round 11: the lock budget always restores the caller\'s lock_timeout', () => {
  beforeAll(async () => {
    assertNotProductionDb('D8 round 11 budget restore');
    c = await setup('D8R11B');
  }, 120000);
  afterAll(async () => { await teardown(c); }, 120000);
  afterEach(() => { vi.restoreAllMocks(); });

  it.each([['DEFAULT', null, '0'], ['a caller\'s 7s', '7s', '7s']] as const)(
    'F3 a Postgres error an inner savepoint rolled back: the transaction is usable and lock_timeout is back to %s',
    async (_what, callerSetting, expected) => {
      const after = await inRolledBackTx(async () => {
        if (callerSetting) await sql`SELECT set_config('lock_timeout', ${callerSetting}, true)`;
        const err = await withRowLockBudget(() => withSavepoint('d8r11_inner', () => sql`SELECT 1/0`), outer)
          .catch((e: unknown) => e);
        expect((err as { code?: string }).code).toBe('22012');
        return setting();
      });
      expect(after).toBe(expected);
    });

  it('F4 a nested helper\'s timeout on an aborted transaction: the typed refusal stands, no ERROR is logged', async () => {
    const bt = await seedBankTx(c.fx, { date: '2026-05-12', amount: -75, description: 'D8R11 held' });
    const errors = vi.spyOn(log, 'error');
    const holder = await c.fx.pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM bank_transactions WHERE id = $1 FOR UPDATE', [bt]);
    try {
      const err = await inRolledBackTx(() => withRowLockBudget(() => lockBankTransactionForUpdate(c.fx.companyId, bt), outer))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BankTransactionLockTimeoutError);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    const restoreErrors = errors.mock.calls.filter(([m]) => /restore lock_timeout/i.test(String(m)));
    expect(restoreErrors, JSON.stringify(restoreErrors)).toEqual([]);
  }, 30000);
});
