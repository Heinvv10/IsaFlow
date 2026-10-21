/**
 * The job's own guards: it refuses to run inside a request (where RLS would show it one tenant and it would
 * publish that one tenant's view as the whole pool), and with no eligible company it publishes an empty
 * pool (everyone opted out -> nothing left), through shared_pool_publish only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { als } from '@/lib/als';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/bureau/services/poolEligibility', () => ({ listPoolEligibleCompanyIds: vi.fn(async () => []) }));

import { runSharedPoolAggregation } from '@/modules/accounting/services/sharedPool/sharedPoolJob';

beforeEach(() => { sqlMock.mockReset(); });

describe('runSharedPoolAggregation', () => {
  it('refuses inside a request context and touches nothing', async () => {
    await expect(als.run({ claims: {} } as never, () => runSharedPoolAggregation())).rejects.toThrow(/off any request transaction/);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('with no eligible company it publishes an empty pool through shared_pool_publish', async () => {
    sqlMock.mockResolvedValue([{ published: 0 }]);
    const r = await runSharedPoolAggregation();
    expect(r).toMatchObject({ eligibleCompanies: 0, published: 0, failedCompanies: 0 });
    expect(sqlMock).toHaveBeenCalledTimes(1);
    const [strings, rows, version] = sqlMock.mock.calls[0]!;
    expect((strings as TemplateStringsArray).join('?')).toContain('public.shared_pool_publish(');
    expect(rows).toBe('[]');
    expect(version).toBe(1);
  });
});
