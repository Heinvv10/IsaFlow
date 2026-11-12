/**
 * The date helpers of the hosted Golden Paths seed (scripts/ci/golden-hosted/seed-demo-app.ts): the seed must land
 * in the recent past, in complete months, spread over all of them.
 */
import { describe, it, expect } from 'vitest';
import { PAYROLL_SANDBOX_MONTH } from '../../e2e/golden-paths/_api';
import { RESERVED_PAYROLL_MONTHS, seedDate, seedMonths, seedPayRun, type Client } from '../../../scripts/ci/golden-hosted/seed-demo-app';

describe('seedMonths', () => {
  it('is the 10 complete months before the run, oldest first', () => {
    expect(seedMonths(new Date('2026-11-01T08:00:00Z'))).toEqual([
      '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10',
    ]);
  });

  it('crosses a year end', () => {
    const months = seedMonths(new Date('2027-02-15T08:00:00Z'));
    expect(months[0]).toBe('2026-04');
    expect(months[9]).toBe('2027-01');
    expect(new Set(months).size).toBe(10);
  });

  it('never includes the month of the run (a period still open and in flux)', () => {
    expect(seedMonths(new Date('2026-12-31T23:00:00Z'))).not.toContain('2026-12');
  });
});

describe('seedDate', () => {
  const months = seedMonths(new Date('2026-11-01T08:00:00Z'));

  it('puts every item on day 3..20 of one of the months, so no date is invalid or in the future', () => {
    for (let i = 1; i <= 200; i++) {
      const d = seedDate(months, i);
      expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(months).toContain(d.slice(0, 7));
      const day = Number(d.slice(8));
      expect(day).toBeGreaterThanOrEqual(3);
      expect(day).toBeLessThanOrEqual(20);
    }
  });

  it('spreads items over all the months', () => {
    expect(new Set(Array.from({ length: 80 }, (_, k) => seedDate(months, k + 1).slice(0, 7))).size).toBe(10);
  });
});

describe('seedPayRun', () => {
  const months = seedMonths(new Date('2026-11-01T08:00:00Z'));
  /** A stand-in client: records each call and refuses the ones `refuse` matches. */
  function fake(refuse: (path: string) => boolean = () => false) {
    const calls: string[] = [];
    const answer = (method: string, path: string, body?: unknown) => {
      calls.push(`${method} ${path}${body ? ` ${JSON.stringify(body)}` : ''}`);
      if (refuse(path)) return Promise.reject(new Error(`${path} refused`));
      if (path === '/api/payroll/runs') return Promise.resolve({ id: `run-${calls.length}` });
      if (path === '/api/accounting/approval-requests') return Promise.resolve({ id: 'req', documentDigest: 'dg' });
      return Promise.resolve({ planHash: 'ph' });
    };
    const api = { post: (p: string, b?: unknown) => answer('POST', p, b), get: (p: string) => answer('GET', p) } as unknown as Client;
    return { api, calls };
  }

  it('creates, calculates, clears and approves one run for the newest seeded month, then stops', async () => {
    const { api, calls } = fake();
    await seedPayRun(api, months);
    expect(calls[0]).toBe('POST /api/payroll/runs {"month":10,"year":2026}');
    expect(calls.map((c) => c.split(' ')[1]!.replace(/run-\d+/, 'RUN'))).toEqual([
      '/api/payroll/runs', '/api/payroll/runs/RUN/calculate', '/api/accounting/approval-requests', '/api/accounting/approval-requests',
      '/api/payroll/runs/RUN/journal-plan', '/api/payroll/runs/RUN/approve',
    ]);
    expect(calls[5]).toContain('{"expectedPlanHash":"ph"}');
  });

  it('falls back to an older month only when calculate refuses, and never throws when none works', async () => {
    const refuseNewest = fake((p) => p === '/api/payroll/runs/run-1/calculate');
    await seedPayRun(refuseNewest.api, months);
    const created = refuseNewest.calls.filter((c) => c.startsWith('POST /api/payroll/runs {'));
    expect(created).toEqual(['POST /api/payroll/runs {"month":10,"year":2026}', 'POST /api/payroll/runs {"month":9,"year":2026}']);
    expect(refuseNewest.calls.at(-1)).toContain('/approve');
    const refuseAll = fake((p) => p === '/api/payroll/runs');
    await expect(seedPayRun(refuseAll.api, months)).resolves.toBeUndefined();
  });

  it('stops at the first month that calculates: a failed approval is not retried on an older month', async () => {
    const refuseApproval = fake((p) => p.endsWith('/approve'));
    await seedPayRun(refuseApproval.api, months);
    const created = refuseApproval.calls.filter((c) => c.startsWith('POST /api/payroll/runs {'));
    expect(created).toEqual(['POST /api/payroll/runs {"month":10,"year":2026}']);
    expect(refuseApproval.calls.some((c) => c.includes('"month":9'))).toBe(false);
  });

  it('never seeds a run in a month the golden payroll and close-agent specs reserve', async () => {
    expect(RESERVED_PAYROLL_MONTHS).toEqual(['2027-01', '2027-02']);
    const { api, calls } = fake();
    await seedPayRun(api, seedMonths(new Date('2027-03-05T08:00:00Z')));
    const created = calls.filter((c) => c.startsWith('POST /api/payroll/runs {'));
    expect(created).toEqual(['POST /api/payroll/runs {"month":12,"year":2026}']);
    expect(calls.at(-1)).toContain('/approve');
  });
});

describe('RESERVED_PAYROLL_MONTHS', () => {
  it('holds the golden payroll sandbox month, so a moved sandbox month cannot start receiving a seeded pay run', () => {
    expect(RESERVED_PAYROLL_MONTHS).toContain(PAYROLL_SANDBOX_MONTH);
  });

  it('is skipped by seedPayRun even when it is the newest month', async () => {
    const api = { post: () => Promise.resolve({ id: 'r' }), get: () => Promise.resolve({ planHash: 'p' }) } as unknown as Client;
    const created: string[] = [];
    const spy = { ...api, post: (path: string, body?: unknown) => { if (path === '/api/payroll/runs') created.push(JSON.stringify(body)); return Promise.resolve({ id: 'r', documentDigest: 'd' }); } } as unknown as Client;
    await seedPayRun(spy, ['2026-12', PAYROLL_SANDBOX_MONTH]);
    expect(created).toEqual(['{"month":12,"year":2026}']);
  });
});
