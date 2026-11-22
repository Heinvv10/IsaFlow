/**
 * Round 23 L-1: the per-group elimination lock is transaction-scoped, so a caller outside a transaction is refused (the lock would be released
 * at the end of its own statement and serialise nothing); inside one it is taken on the group's own key.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
import { sql } from '@/lib/neon';
import { lockGroupEliminations } from '@/modules/accounting/services/reports/eliminationLock';

const G = '80000000-0000-4000-8000-000000000001';
const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
beforeEach(() => { mockSql.mockReset(); });

describe('lockGroupEliminations', () => {
  it('takes the advisory lock on the group\'s key, then checks it is still held', async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([{ '?column?': 1 }]);
    await expect(lockGroupEliminations(G, 'caller')).resolves.toBeUndefined();
    expect(mockSql).toHaveBeenCalledTimes(2);
    expect((mockSql.mock.calls[0]![0] as string[]).join('?')).toContain('pg_advisory_xact_lock');
    expect(mockSql.mock.calls[0]!.slice(1)).toEqual([G]);
  });

  it('a lock that is no longer held (not inside a transaction) is refused, naming the caller', async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await expect(lockGroupEliminations(G, 'assertMirroredRowResolvable')).rejects.toThrow(/assertMirroredRowResolvable must run inside a transaction/);
  });
});
