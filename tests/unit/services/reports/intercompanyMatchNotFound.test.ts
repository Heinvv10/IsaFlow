/**
 * D4 round 10: matchIntercompanyTransactions throws a TYPED not-found (IntercompanyNotFoundError,
 * naming the ids missing from this group) instead of a plain Error, and writes nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { sql } from '@/lib/neon';
import { IntercompanyNotFoundError, matchIntercompanyTransactions } from '@/modules/accounting/services/reports/intercompanyService';

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const G = '80000000-0000-4000-8000-000000000001';
const T1 = '60000000-0000-4000-8000-000000000001';
const T2 = '60000000-0000-4000-8000-000000000002';

beforeEach(() => { mockSql.mockReset(); });

describe('matchIntercompanyTransactions', () => {
  it.each([
    ['target missing', [[{ id: T1, amount: 10 }], []], [T2]],
    ['source missing', [[], [{ id: T2, amount: 10 }]], [T1]],
    ['both missing', [[], []], [T1, T2]],
  ] as const)('%s → IntercompanyNotFoundError, no UPDATE', async (_n, results, missing) => {
    for (const r of results) mockSql.mockResolvedValueOnce(r);
    const err = await matchIntercompanyTransactions(T1, T2, G).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntercompanyNotFoundError);
    expect(err).toMatchObject({ missing });
    expect(mockSql).toHaveBeenCalledTimes(2);
  });
});
