/**
 * sage_connect_pulls through its life (sageTakeOnStore). The job-side writes
 * run as the pool role outside RLS, so every statement must name the company,
 * and every move out of 'pulling' must be fenced on the row still pulling — a
 * read discarded meanwhile is never overwritten by a late result. A read gone
 * quiet reads as failed; a review past its TTL is expired, its data cleared.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import { sql } from '@/lib/neon';
import {
  discardPull, latestOpenPull, loadPullForImport, loadPullState, markPullFailed, markPullReady,
  purgeExpiredPulls, purgeExpiredPullsEverywhere, SagePullRefused, startPull, STALE_PULL_ERROR, touchPull,
} from '@/modules/accounting/services/sage/sageTakeOnStore';
import { sageFixture } from './sageFixture';
import { summarise } from '@/modules/accounting/services/sage/sageTakeOnTypes';
import { buildSageTakeOn } from '@/modules/accounting/services/sage/sageTakeOnBuilder';
import { emptyCompany } from './sageFixture';

type Call = { text: string; values: unknown[] };
const sqlMock = vi.mocked(sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>);
const calls = (): Call[] => sqlMock.mock.calls.map(([s, ...v]) => ({ text: s.join('?').replace(/\s+/g, ' '), values: v }));
const CO = 'c0000000-0000-4000-8000-000000000001';
const PULL = 'p0000000-0000-4000-8000-000000000001';

function answer(fn: (text: string) => unknown[]) {
  sqlMock.mockImplementation(async (s: TemplateStringsArray) => fn(s.join('?')));
}

beforeEach(() => { sqlMock.mockReset(); answer(() => []); });

const everyCallNamesTheCompany = () => {
  for (const c of calls().filter((x) => /sage_connect_pulls/.test(x.text))) {
    if (!c.text.includes('INSERT INTO')) expect(c.text).toMatch(/company_id = \?/);
    expect(c.values).toContain(CO);
  }
};

describe('startPull', () => {
  it('serialises on a per-company lock, expires stale rows, then inserts a pulling row with a heartbeat', async () => {
    answer((t) => (t.includes('INSERT INTO') ? [{ id: PULL }] : []));
    expect(await startPull(CO, 'u', 555, '2026-10-21')).toBe(PULL);
    const texts = calls().map((c) => c.text);
    expect(texts[0]).toMatch(/pg_advisory_xact_lock/);
    expect(calls()[0]!.values[0]).toBe(`${CO}:sage-pull`);
    expect(texts.findIndex((t) => t.includes('INSERT INTO'))).toBeGreaterThan(texts.findIndex((t) => t.includes("status = 'pulling' LIMIT 1")));
    expect(texts.find((t) => t.includes('INSERT INTO'))).toMatch(/'pulling', NOW\(\)/);
    everyCallNamesTheCompany();
  });

  it('refuses a second read while one is running for the company, inserting nothing', async () => {
    answer((t) => (t.includes("status = 'pulling' LIMIT 1") ? [{ id: 'other' }] : []));
    await expect(startPull(CO, 'u', 555, '2026-10-21')).rejects.toBeInstanceOf(SagePullRefused);
    expect(calls().some((c) => c.text.includes('INSERT INTO'))).toBe(false);
  });
});

describe('the job\'s writes are fenced and scoped', () => {
  it.each([
    ['touchPull', () => touchPull(CO, PULL, 'Reading customers')],
    ['markPullReady', () => markPullReady(CO, PULL, sageFixture(), summarise(buildSageTakeOn(sageFixture(), emptyCompany)))],
    ['markPullFailed', () => markPullFailed(CO, PULL, 'nope')],
  ])('%s writes only a row of this company still pulling', async (_n, run) => {
    await run();
    const c = calls()[0]!;
    expect(c.text).toMatch(/WHERE id = \?::UUID AND company_id = \?::UUID AND status = 'pulling'/);
    expect(c.values).toEqual(expect.arrayContaining([PULL, CO]));
  });

  it('markPullReady reports a row that had left pulling (dropped result)', async () => {
    answer(() => []);
    expect(await markPullReady(CO, PULL, sageFixture(), summarise(buildSageTakeOn(sageFixture(), emptyCompany)))).toBe(false);
    answer(() => [{ id: PULL }]);
    expect(await markPullFailed(CO, PULL, 'x')).toBe(true);
  });

  it('touchPull says whether the row is still pulling, so the job can stop (R1)', async () => {
    answer(() => []);
    expect(await touchPull(CO, PULL)).toBe(false);
    answer(() => [{ id: PULL }]);
    expect(await touchPull(CO, PULL)).toBe(true);
    expect(calls().at(-1)!.text).toMatch(/RETURNING id/);
  });
});

describe('reading the row', () => {
  it('a pulling row gone quiet reads as failed, with the interrupted message', async () => {
    answer(() => [{ id: PULL, status: 'pulling', progress: 'Reading suppliers', error: null, pull: null, stale: true }]);
    expect(await loadPullState(CO, PULL)).toEqual({ id: PULL, status: 'failed', progress: null, error: STALE_PULL_ERROR, pull: null });
    everyCallNamesTheCompany();
  });

  it('a live pulling row keeps its progress', async () => {
    answer(() => [{ id: PULL, status: 'pulling', progress: 'Reading suppliers', error: null, pull: null, stale: false }]);
    expect(await loadPullState(CO, PULL)).toMatchObject({ status: 'pulling', progress: 'Reading suppliers' });
  });

  it('latestOpenPull does not offer a stale read for resuming', async () => {
    answer(() => [{ id: PULL, status: 'pulling', stale: true }]);
    expect(await latestOpenPull(CO)).toBeNull();
    answer(() => [{ id: PULL, status: 'ready', stale: true }]);
    expect(await latestOpenPull(CO)).toEqual({ pullId: PULL, status: 'ready' });
  });

  it('loadPullForImport locks the row and says whether the review is past its TTL', async () => {
    answer(() => [{ id: PULL, status: 'ready', pull: JSON.stringify(sageFixture()), expired: true }]);
    const s = await loadPullForImport(CO, PULL);
    expect(s).toMatchObject({ status: 'ready', expired: true });
    expect(s!.pull!.company.id).toBe(555);
    expect(calls()[0]!.text).toMatch(/FOR UPDATE/);
    everyCallNamesTheCompany();
  });
});

describe('expiry and discard', () => {
  it('purgeExpiredPulls clears the pull of this company\'s reviews past 24 h and fails its quiet reads', async () => {
    await purgeExpiredPulls(CO);
    const [expire, fail] = calls();
    expect(expire!.text).toMatch(/SET status = 'expired', pull = NULL/);
    expect(expire!.values).toEqual([CO, 24]);
    expect(fail!.text).toMatch(/SET status = 'failed'/);
    expect(fail!.values).toEqual([STALE_PULL_ERROR, CO, 15]);
  });

  it('purgeExpiredPullsEverywhere sweeps every tenant and counts what it expired', async () => {
    answer(() => [{ id: 'a' }, { id: 'b' }]);
    expect(await purgeExpiredPullsEverywhere()).toBe(2);
    expect(calls()[0]!.text).not.toMatch(/company_id/);
    expect(calls()[0]!.text).toMatch(/pull = NULL/);
  });

  it('discard clears the pull and works on a read under way or failed too', async () => {
    answer(() => [{ id: PULL }]);
    expect(await discardPull(CO, PULL)).toBe(true);
    expect(calls()[0]!.text).toMatch(/pull = NULL/);
    expect(calls()[0]!.text).toMatch(/status IN \('pulling', 'ready', 'failed'\)/);
    everyCallNamesTheCompany();
  });
});
