/**
 * inRolledBackSavepoint runs a write for real and always rolls it back, so a
 * dry run meets every check the live call meets. #683 round 3: if the
 * ROLLBACK TO itself fails, the write may still stand and the transaction is
 * dead — that must never come back as a dry-run success.
 *
 * The REAL AsyncLocalStorage and the REAL withSavepoint, entered with a
 * scripted client (as savepointRollbackPoison.test.ts does): assertTxUsable
 * closes over als.ts's own store, so a module mock would never reach it.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { als } from '@/lib/als';
import { inRolledBackSavepoint } from '@/modules/accounting/services/core/rolledBackSavepoint';

function enter(queryImpl: (text: string) => Promise<unknown>) {
  const ctx = { client: { query: vi.fn(async (text: string) => queryImpl(text)) }, userId: 'u1', claims: {} };
  als.enterWith(ctx as unknown as Parameters<typeof als.enterWith>[0]);
  return ctx;
}

describe('inRolledBackSavepoint', () => {
  it('runs the write, rolls it back and reports success when the rollback works', async () => {
    const ctx = enter(async () => ({ rows: [] }));
    const fn = vi.fn(async () => undefined);
    await expect(inRolledBackSavepoint('sp_probe', fn)).resolves.toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);
    const texts = ctx.client.query.mock.calls.map((c) => c[0]);
    expect(texts).toEqual(['SAVEPOINT sp_probe', 'ROLLBACK TO SAVEPOINT sp_probe', 'RELEASE SAVEPOINT sp_probe']);
  });

  it('passes a refusal from the write through', async () => {
    enter(async () => ({ rows: [] }));
    await expect(inRolledBackSavepoint('sp_probe', async () => { throw new Error('in use'); })).rejects.toThrow('in use');
  });

  it('does NOT report success when the ROLLBACK TO fails: the write may stand and the transaction is dead', async () => {
    enter(async (text) => {
      if (text.startsWith('ROLLBACK TO')) throw new Error('connection terminated');
      return { rows: [] };
    });
    await expect(inRolledBackSavepoint('sp_probe', async () => undefined))
      .rejects.toThrow(/Request transaction is unusable — a savepoint rollback failed earlier/);
  });

  it('is refused outside a request transaction, where nothing could roll the write back', async () => {
    als.enterWith(undefined as unknown as Parameters<typeof als.enterWith>[0]);
    const fn = vi.fn(async () => undefined);
    await expect(inRolledBackSavepoint('sp_probe', fn)).rejects.toThrow(/requires a request transaction/);
    expect(fn).not.toHaveBeenCalled();
  });
});
