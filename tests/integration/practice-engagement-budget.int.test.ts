// tests/integration/practice-engagement-budget.int.test.ts
//
// Engagement Budgets (migrations 850, 851): consumption and the report.
// A firm partner asked how much of the approved value of an engagement is
// still available to spend on time. The budget is `practice_jobs.budget_amount`;
// consumption is every time entry on that job in the same company AND the
// job's own client, EXCEPT `leave`, valued at ROUND(hours × applied_rate, 2)
// per entry — drafts, submitted, approved, billed, invoiced, non-billable and
// written-off time all count. A NULL rate adds hours but no rand.
// Fixture: practice-engagement-budget.helpers.ts (isaflow_dev, own companies).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import budgetsRoute from '../../pages/api/accounting/practice/reports/engagement-budgets';
import { listJobBudgetStatuses } from '@/modules/accounting/services/practice/practiceJobBudgetService';
import { createEbFixture, ebDbAvailable, type EbFixture } from './practice-engagement-budget.helpers';

const describeIfDb = ebDbAvailable ? describe : describe.skip;

describeIfDb('Engagement budgets — consumption and the report', () => {
  let f: EbFixture;
  const J: Record<string, string> = {};
  const status = async (jobId: string) => {
    const rows = await f.inTx(() => listJobBudgetStatuses(f.A, { jobId }));
    expect(rows.length).toBeLessThanOrEqual(1);
    return rows[0] ?? null;
  };

  beforeAll(async () => {
    f = await createEbFixture('EBC');
    J.main = await f.job(f.A, f.CLIENT, 'EBC job', { budget: 10000, hours: 20 });
    J.other = await f.job(f.A, f.CLIENT, 'EBC other job');
    J.none = await f.job(f.A, f.CLIENT, 'EBC no budget', { hours: 5 });
    J.warn = await f.job(f.A, f.CLIENT, 'EBC warn', { budget: 1000 });
    J.over = await f.job(f.A, f.CLIENT, 'EBC over', { budget: 500 });
    J.empty = await f.job(f.A, f.CLIENT, 'EBC empty', { budget: 250, hours: 3 });
    J.client2 = await f.job(f.A, f.CLIENT2, 'EBC client 2 job', { budget: 100 });
    J.round = await f.job(f.A, f.CLIENT2, 'EBC rounding', { budget: 300 });
    J.onB = await f.job(f.A, f.CLIENT_B, 'EBC job on B client', { budget: 1 }); // A's job, B's client (tenant-agnostic FK)
    J.b = await f.job(f.B, f.CLIENT_B, 'EBC B job', { budget: 999 });
    J.bOnA = await f.job(f.B, f.CLIENT, 'EBC B job on A client', { budget: 1 });

    for (const st of ['draft', 'submitted', 'approved', 'billed', 'invoiced']) {
      await f.entry({ job: J.main!, hours: 1, rate: 1000, status: st });
    }
    await f.entry({ job: J.main!, hours: 1, rate: 1000, status: 'not_billable', billable: false }); // written off
    await f.entry({ job: J.main!, hours: 1, rate: 1000, billable: false });                         // non-billable
    await f.entry({ job: J.main!, hours: 1.5, rate: null });                                         // no rate
    await f.entry({ job: J.main!, hours: 2, rate: 1000, status: 'leave' });                          // excluded
    await f.entry({ job: J.other!, hours: 5, rate: 1000, status: 'approved' });                      // another job
    // Company B's entry on A's job (pre-851 shape) and an A entry for CLIENT2 on CLIENT's job: neither counts.
    await f.plantLegacy({ company: f.B, client: f.CLIENT_B, cat: f.CAT_B, item: f.ITEM_B, job: J.main!, hours: 3, rate: 1000, desc: 'EBC planted B' });
    await f.plantLegacy({ company: f.A, client: f.CLIENT2, cat: f.CAT, item: f.ITEM, job: J.main!, hours: 4, rate: 1000, desc: 'EBC planted client2' });
    // Company B's entry carrying A's OWN client id: only the te.company_id = pj.company_id clause keeps it out.
    await f.plantLegacy({ company: f.B, client: f.CLIENT, cat: f.CAT_B, item: f.ITEM_B, job: J.main!, hours: 6, rate: 1000, desc: 'EBC planted B same client' });
    await f.entry({ job: J.none!, hours: 2, rate: 1000, status: 'submitted' });
    await f.entry({ job: J.warn!, hours: 0.8, rate: 1000, status: 'approved' });
    await f.entry({ job: J.over!, hours: 1, rate: 1000, status: 'approved' });
    // 3 × 0.33h × R101.50 = 3 × ROUND(33.495, 2) = 3 × 33.50 = 100.50 (ROUND of the sum would be 100.49).
    for (let i = 0; i < 3; i++) await f.entry({ client: f.CLIENT2, job: J.round!, hours: 0.33, rate: 101.5 });
  });

  afterAll(async () => { if (f) await f.cleanup(); });

  it('counts every non-leave entry on the job at hours × rate — only this company\'s, only this client\'s', async () => {
    expect(await status(J.main!)).toMatchObject({
      jobId: J.main, budgetAmount: 10000, consumedAmount: 7000, balance: 3000,
      budgetedHours: 20, hoursUsed: 8.5, percentUsed: 70, state: 'ok',
    });
  });

  it('a job with no time has consumed 0 and hours 0', async () => {
    expect(await status(J.empty!)).toMatchObject({
      consumedAmount: 0, hoursUsed: 0, balance: 250, budgetedHours: 3, percentUsed: 0, state: 'ok',
    });
  });

  it('a NULL budget is state none with no balance, but still reports what was used', async () => {
    expect(await status(J.none!)).toMatchObject({ budgetAmount: null, consumedAmount: 2000, balance: null,
      budgetedHours: 5, hoursUsed: 2, percentUsed: null, state: 'none' });
  });

  it('80% used is a warning; over budget is a negative balance', async () => {
    expect(await status(J.warn!)).toMatchObject({ consumedAmount: 800, balance: 200, percentUsed: 80, state: 'warning' });
    expect(await status(J.over!)).toMatchObject({ consumedAmount: 1000, balance: -500, percentUsed: 200, state: 'over' });
  });

  it('rounds each entry to the cent before summing', async () => {
    expect(await status(J.round!)).toMatchObject({ consumedAmount: 100.5, hoursUsed: 0.99, balance: 199.5, percentUsed: 33.5 });
  });

  it('another company\'s job is not found, even one on this company\'s client', async () => {
    expect(await status(J.b!)).toBeNull();
    expect(await status(J.bOnA!)).toBeNull();
  });

  it('names the client by trading name, falling back to the legal name; never another company\'s client', async () => {
    const rows = await f.inTx(() => listJobBudgetStatuses(f.A, {}));
    expect(rows.find((r) => r.jobId === J.main)?.practiceClientName).toBe('EBC Client');
    expect(rows.find((r) => r.jobId === J.client2)?.practiceClientName).toBe('EBC Client 2 Ltd');
    expect(rows.find((r) => r.jobId === J.onB)?.practiceClientName).toBeNull();
  });

  it('lists the company\'s jobs over-budget first, then warning, ok, and no budget last', async () => {
    const rows = await f.inTx(() => listJobBudgetStatuses(f.A, {}));
    const ids = rows.map((r) => r.jobId);
    expect(ids).not.toContain(J.b);
    expect(ids).not.toContain(J.bOnA);
    expect(rows[0]).toMatchObject({ jobId: J.over, title: 'EBC over', state: 'over' });
    const order = { over: 0, warning: 1, ok: 2, none: 3 } as const;
    const ranks = rows.map((r) => order[r.state]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('filters by client', async () => {
    const rows = await f.inTx(() => listJobBudgetStatuses(f.A, { practiceClientId: f.CLIENT2 }));
    expect(rows.map((r) => r.jobId).sort()).toEqual([J.client2, J.round].sort());
  });

  describe('GET /reports/engagement-budgets', () => {
    it('returns one job\'s status through withAuth', async () => {
      const one = await f.call(budgetsRoute, 'GET', {}, { jobId: J.warn! });
      expect(one.statusCode, JSON.stringify(one.body)).toBe(200);
      expect(one.body.data).toEqual([expect.objectContaining({ jobId: J.warn, state: 'warning' })]);
    });

    it('returns nothing for another company\'s job', async () => {
      const r = await f.call(budgetsRoute, 'GET', {}, { jobId: J.b! });
      expect(r.statusCode).toBe(200);
      expect(r.body.data).toEqual([]);
    });

    it('answers a malformed id with 400', async () => {
      expect((await f.call(budgetsRoute, 'GET', {}, { jobId: 'nope' })).statusCode).toBe(400);
      expect((await f.call(budgetsRoute, 'GET', {}, { practiceClientId: 'nope' })).statusCode).toBe(400);
    });
  });
});
