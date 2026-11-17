/**
 * WP2 row 5 round 2 (brk-1494 LOW 2 / the deadlock recipe): a pair lock the pre-lock does not get — a deadlock that
 * picks this request as its victim (40P01) as much as a wait that ran out (55P03) — is a CONTENDED pair: its key comes
 * back for the caller to skip, and the batch goes on (each pair in its own savepoint). Anything else is a failure.
 * Unit-level because a 40P01 inside the pre-lock cannot be produced on demand now every batch takes line -> pair.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlMock, client } = vi.hoisted(() => ({
  sqlMock: vi.fn(),
  client: { query: vi.fn(async () => ({ rows: [{ prev: '0', v: '0' }] })) },
}));
vi.mock('@/lib/neon', () => ({ sql: sqlMock, withSavepoint: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()) }));
vi.mock('@/lib/als', () => ({ als: { getStore: () => ({ client }) }, assertTxUsable: () => undefined }));

import { preLockTransferPairs, transferPairKey } from '@/modules/accounting/services/bank/transferPairLock';

const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });
const CO = '00000000-0000-0000-0000-0000000000c0';

describe('preLockTransferPairs', () => {
  beforeEach(() => { sqlMock.mockReset(); client.query.mockClear(); });

  it.each(['40P01', '55P03'])('a %s on one pair skips that pair as contended and takes the next', async (code) => {
    sqlMock.mockRejectedValueOnce(pgError(code)).mockResolvedValueOnce([]);
    const held = await preLockTransferPairs(CO, [['a', 'b'], ['a', 'c']]);
    const [first] = [transferPairKey(CO, 'a', 'b'), transferPairKey(CO, 'a', 'c')].sort();
    expect([...held]).toEqual([first]);
    expect(sqlMock).toHaveBeenCalledTimes(2);
  });

  it('any other error is rethrown', async () => {
    sqlMock.mockRejectedValueOnce(pgError('23505'));
    await expect(preLockTransferPairs(CO, [['a', 'b']])).rejects.toThrow(/pg 23505/);
  });

  it('puts the request\'s own lock_timeout back afterwards', async () => {
    sqlMock.mockResolvedValue([]);
    await preLockTransferPairs(CO, [['a', 'b']]);
    const calls = client.query.mock.calls as unknown as Array<[string, unknown[]?]>;
    expect(calls.at(-1)).toEqual(["SELECT set_config('lock_timeout', $1, true)", ['0']]);
  });
});
