/**
 * `withAlsTransaction` — the transaction that lets a service compose other
 * services without leaving half of them committed.
 *
 * `withTransaction` hands its callback a `tx` function, so anything the callback
 * CALLS still reaches the pool on its own connection and commits independently.
 * This one binds the client into ALS instead, so every nested `sql` joins it.
 * Three things have to hold: the context carries the caller's real tenant and
 * user (something nested reading requireCtx() must not see a placeholder), the
 * connection is always returned, and a connection whose ROLLBACK itself failed
 * is DESTROYED rather than handed to the next caller with an aborted
 * transaction still open on it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pgTypesMock } from '../helpers/pgTypesMock';

const { clientQueryMock, releaseMock } = vi.hoisted(() => ({
  clientQueryMock: vi.fn(),
  releaseMock: vi.fn(),
}));

vi.mock('pg', () => ({
  default: {
    ...pgTypesMock(),
    Pool: class {
      connect = async () => ({ query: clientQueryMock, release: releaseMock });
      on = () => undefined;
      end = vi.fn();
    },
  },
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { withAlsTransaction } from '@/lib/alsTransaction';
import { als } from '@/lib/als';

const USER = 'uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu';
const COMPANY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

beforeEach(() => {
  clientQueryMock.mockReset().mockResolvedValue({ rows: [] });
  releaseMock.mockReset();
});

function statements(): string[] {
  return clientQueryMock.mock.calls.map((c) => String(c[0]));
}

describe('withAlsTransaction', () => {
  it('binds the caller tenant and user, so nothing nested reads a placeholder', async () => {
    const seen = await withAlsTransaction({ userId: USER, companyId: COMPANY }, async () => als.getStore());

    expect(seen?.userId).toBe(USER);
    expect(seen?.companyId).toBe(COMPANY);
    expect(statements()).toContain('BEGIN');
    expect(statements()).toContain('COMMIT');
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(releaseMock.mock.calls[0]![0]).toBeUndefined();
  });

  it('reuses the request transaction instead of opening a second one', async () => {
    const requestClient = { query: vi.fn(), release: vi.fn() } as never;
    const seen = await als.run(
      { client: requestClient, userId: 'request-user', companyId: 'request-company', claims: {} },
      () => withAlsTransaction({ userId: USER, companyId: COMPANY }, async () => als.getStore()),
    );

    // Opening a second transaction would take another pool client and deadlock
    // against the rows this request already holds.
    expect(clientQueryMock).not.toHaveBeenCalled();
    expect(seen?.userId).toBe('request-user');
  });

  it('rolls back and returns the connection when the callback throws', async () => {
    await expect(withAlsTransaction({ userId: USER, companyId: COMPANY }, async () => { throw new Error('boom'); }))
      .rejects.toThrow('boom');

    expect(statements()).toContain('ROLLBACK');
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(releaseMock.mock.calls[0]![0]).toBeUndefined();
  });

  it('DESTROYS a connection whose ROLLBACK failed, and still throws the original error', async () => {
    clientQueryMock.mockImplementation(async (text: string) => {
      if (text === 'ROLLBACK') throw new Error('connection reset');
      return { rows: [] };
    });

    await expect(withAlsTransaction({ userId: USER, companyId: COMPANY }, async () => { throw new Error('the real cause'); }))
      .rejects.toThrow('the real cause');

    // Handing this back to the pool would give the next caller an aborted
    // transaction on a connection it believes is clean.
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(releaseMock.mock.calls[0]![0]).toBeInstanceOf(Error);
  });
});
