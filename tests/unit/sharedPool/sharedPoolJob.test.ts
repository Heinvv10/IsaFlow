/**
 * The job's own guards: it refuses to run inside a request (where RLS would show it one tenant and it would
 * publish that one tenant's view as the whole pool), and with no eligible company it publishes an empty
 * pool (everyone opted out -> nothing left), through shared_pool_publish only. While the legal-review gate
 * (MERCHANT_SHARING_ENABLED) is off it reads and writes nothing at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { als } from '@/lib/als';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const { listPoolEligibleCompanyIds } = vi.hoisted(() => ({ listPoolEligibleCompanyIds: vi.fn(async (): Promise<string[]> => []) }));
vi.mock('@/modules/bureau/services/poolEligibility', () => ({ listPoolEligibleCompanyIds }));

import { isSharedPoolRunning, runSharedPoolAggregation } from '@/modules/accounting/services/sharedPool/sharedPoolJob';
import { MERCHANT_FILTER_VERSION } from '@/modules/accounting/services/sharedPool/merchantPiiFilter';

beforeEach(() => {
  sqlMock.mockReset(); listPoolEligibleCompanyIds.mockReset(); listPoolEligibleCompanyIds.mockResolvedValue([]);
  process.env.MERCHANT_SHARING_ENABLED = 'true';
});
afterEach(() => { delete process.env.MERCHANT_SHARING_ENABLED; });
const published = () => sqlMock.mock.calls.filter(([s]) => (s as TemplateStringsArray).join('?').includes('shared_pool_publish'));

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
    expect(version).toBe(MERCHANT_FILTER_VERSION);
  });

  it('one company read failing publishes nothing: the previous pool stands', async () => {
    listPoolEligibleCompanyIds.mockResolvedValue(['co-a', 'co-b']);
    sqlMock.mockImplementation(async (_s: TemplateStringsArray, ...v: unknown[]) => {
      if (v[0] === 'co-b') throw new Error('connection terminated');
      return [];
    });
    await expect(runSharedPoolAggregation()).rejects.toThrow(/1 of 2 company reads failed; nothing published/);
    expect(published()).toHaveLength(0);
  });

  it('every company read failing does not publish an empty pool', async () => {
    listPoolEligibleCompanyIds.mockResolvedValue(['co-a', 'co-b']);
    sqlMock.mockRejectedValue(new Error('the database is down'));
    await expect(runSharedPoolAggregation()).rejects.toThrow(/nothing published/);
    expect(published()).toHaveLength(0);
  });

  it('a second run while one is in progress is refused; the slot frees when the first ends', async () => {
    let release: () => void = () => undefined;
    listPoolEligibleCompanyIds.mockImplementationOnce(() => new Promise<string[]>((r) => { release = () => r([]); }));
    sqlMock.mockResolvedValue([{ published: 0 }]);
    const first = runSharedPoolAggregation();
    expect(isSharedPoolRunning()).toBe(true);
    await expect(runSharedPoolAggregation()).rejects.toThrow(/already running/);
    release();
    await first;
    expect(isSharedPoolRunning()).toBe(false);
    await expect(runSharedPoolAggregation()).resolves.toMatchObject({ published: 0 });
  });
});

describe('the legal-review gate (MERCHANT_SHARING_ENABLED)', () => {
  it.each([undefined, 'false', 'TRUE', '1'])('MERCHANT_SHARING_ENABLED=%s: skipped, nothing read or written', async (v) => {
    if (v === undefined) delete process.env.MERCHANT_SHARING_ENABLED; else process.env.MERCHANT_SHARING_ENABLED = v;
    listPoolEligibleCompanyIds.mockResolvedValue(['co-a']);
    sqlMock.mockResolvedValue([{ published: 0 }]);
    await expect(runSharedPoolAggregation()).resolves.toEqual({
      skipped: true, reason: 'sharing_pending_legal_review', message: 'skipped: sharing disabled pending legal review',
    });
    expect(listPoolEligibleCompanyIds).not.toHaveBeenCalled();
    expect(sqlMock).not.toHaveBeenCalled();
    expect(isSharedPoolRunning()).toBe(false);
  });

  it("MERCHANT_SHARING_ENABLED='true': the run reads eligibility and publishes", async () => {
    sqlMock.mockResolvedValue([{ published: 0 }]);
    const r = await runSharedPoolAggregation();
    expect(r).not.toHaveProperty('skipped');
    expect(listPoolEligibleCompanyIds).toHaveBeenCalledTimes(1);
    expect(published()).toHaveLength(1);
  });
});
