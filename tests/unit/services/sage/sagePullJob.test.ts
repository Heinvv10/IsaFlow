/**
 * The background Sage read (sagePullJob). It never throws; it ends the row
 * 'ready' or 'failed' with a message safe to show (Sage's own plain-language
 * errors or the size refusal — anything else is hidden behind a generic one);
 * the login it holds is never in anything it writes; and at most
 * MAX_CONCURRENT_PULLS run at once in the process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  pullSageCompany: vi.fn(), readTakeOnContext: vi.fn(),
  markPullReady: vi.fn(), markPullFailed: vi.fn(), touchPull: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/sage/sageApiPullService', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/sage/sageApiPullService')>()),
  pullSageCompany: m.pullSageCompany,
}));
vi.mock('@/modules/accounting/services/sage/sageTakeOnContext', () => ({ readTakeOnContext: m.readTakeOnContext }));
vi.mock('@/modules/accounting/services/sage/sageTakeOnStore', () => ({
  markPullReady: m.markPullReady, markPullFailed: m.markPullFailed, touchPull: m.touchPull,
}));

import { SageApiError, type SageApiClient } from '@/modules/accounting/services/sage/sageApiClient';
import { SagePullTooLargeError } from '@/modules/accounting/services/sage/sageApiPullService';
import { BUSY_MESSAGE, MAX_CONCURRENT_PULLS, pullSlotFree, runSagePull } from '@/modules/accounting/services/sage/sagePullJob';
import { emptyCompany, sageFixture } from './sageFixture';

const client = { listCompanies: vi.fn(), forCompany: vi.fn() } as unknown as SageApiClient;
const job = (pullId = 'p-1') => ({ companyId: 'co-1', pullId, client, sageCompanyId: 555, asAtDate: '2026-10-21' });

beforeEach(() => {
  vi.clearAllMocks();
  m.readTakeOnContext.mockResolvedValue(emptyCompany);
  m.markPullReady.mockResolvedValue(true);
  m.markPullFailed.mockResolvedValue(true);
  m.touchPull.mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); });

describe('runSagePull', () => {
  it('reads, builds against the company and stores the pull with its summary', async () => {
    m.pullSageCompany.mockImplementation(async (_c, _id, _d, onProgress: (s: string) => void) => { onProgress('customers'); return sageFixture(); });
    await runSagePull(job());
    expect(m.pullSageCompany).toHaveBeenCalledWith(client, 555, '2026-10-21', expect.any(Function));
    expect(m.readTakeOnContext).toHaveBeenCalledWith('co-1');
    expect(m.touchPull).toHaveBeenCalledWith('co-1', 'p-1', 'Reading customers');
    const [co, id, pull, summary] = m.markPullReady.mock.calls[0]!;
    expect([co, id]).toEqual(['co-1', 'p-1']);
    expect(pull).toEqual(sageFixture());
    expect(summary).toMatchObject({ sageCompanyName: 'Acme Media (Pty) Ltd', errors: 0 });
    expect(m.markPullFailed).not.toHaveBeenCalled();
  });

  it.each([
    ['Sage\'s own error', new SageApiError('auth', 401), /email address or password/],
    ['the size refusal', new SagePullTooLargeError('too big, use the file upload'), /file upload/],
  ])('fails the row with %s, which is written for the client', async (_n, err, msg) => {
    m.pullSageCompany.mockRejectedValue(err);
    await runSagePull(job());
    expect(m.markPullFailed).toHaveBeenCalledWith('co-1', 'p-1', expect.stringMatching(msg));
  });

  it('hides anything else behind a generic message (it may name a host or carry the login)', async () => {
    m.pullSageCompany.mockRejectedValue(new Error('connect ECONNREFUSED owner@acme.test:s3cret! 10.0.0.5'));
    await runSagePull(job());
    const message = m.markPullFailed.mock.calls[0]![2] as string;
    expect(message).toMatch(/could not finish reading from Sage/);
    expect(message).not.toMatch(/s3cret|ECONNREFUSED|10\.0\.0\.5/);
  });

  it('never throws, even when recording the failure fails', async () => {
    m.pullSageCompany.mockRejectedValue(new Error('x'));
    m.markPullFailed.mockRejectedValue(new Error('db down'));
    await expect(runSagePull(job())).resolves.toBeUndefined();
  });

  it('beats while a long stretch of calls runs, and stops when done', async () => {
    vi.useFakeTimers();
    let finish: (v: unknown) => void = () => {};
    m.pullSageCompany.mockReturnValue(new Promise((r) => { finish = r; }));
    const running = runSagePull(job());
    await vi.advanceTimersByTimeAsync(130_000);
    expect(m.touchPull).toHaveBeenCalledTimes(2);
    finish(sageFixture());
    await running;
    await vi.advanceTimersByTimeAsync(130_000);
    expect(m.touchPull).toHaveBeenCalledTimes(2);
  });
});

describe('process-wide slots', () => {
  it(`runs at most ${MAX_CONCURRENT_PULLS} reads at once; the next fails at once as busy, and a slot frees when one ends`, async () => {
    const finishers: ((v: unknown) => void)[] = [];
    m.pullSageCompany.mockImplementation(() => new Promise((r) => { finishers.push(r); }));
    const running = Array.from({ length: MAX_CONCURRENT_PULLS }, (_, i) => runSagePull(job(`p-${i}`)));
    await vi.waitFor(() => expect(finishers).toHaveLength(MAX_CONCURRENT_PULLS));
    expect(pullSlotFree()).toBe(false);

    await runSagePull(job('p-extra'));
    expect(m.markPullFailed).toHaveBeenCalledWith('co-1', 'p-extra', BUSY_MESSAGE);
    expect(m.pullSageCompany).toHaveBeenCalledTimes(MAX_CONCURRENT_PULLS);

    finishers.forEach((f) => f(sageFixture()));
    await Promise.all(running);
    expect(pullSlotFree()).toBe(true);
  });

  it('frees the slot when a read fails', async () => {
    m.pullSageCompany.mockRejectedValue(new Error('x'));
    for (let i = 0; i < MAX_CONCURRENT_PULLS + 1; i++) await runSagePull(job(`f-${i}`));
    expect(pullSlotFree()).toBe(true);
    expect(m.markPullFailed).not.toHaveBeenCalledWith('co-1', expect.any(String), BUSY_MESSAGE);
  });
});
