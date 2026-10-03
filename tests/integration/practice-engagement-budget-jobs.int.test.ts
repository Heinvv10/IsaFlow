// tests/integration/practice-engagement-budget-jobs.int.test.ts
//
// Engagement Budgets on the job itself:
// - `budgetAmount` on create/update: absent or undefined keeps it, null/'' clears
//   it, anything that is not an amount from 0 to below 10^13 is a 400 with its
//   own message (JobBudgetInvalidError), and a large budget keeps its cents.
// - Migration 851: a job whose time entries are its current client's cannot
//   be moved to another client (composite FK, ON UPDATE RESTRICT). updateJob
//   turns the 23503 into JobClientHasEntriesError inside a savepoint; the PUT
//   route answers 400. The FK also refuses a mismatched entry written directly.
// Fixture: practice-engagement-budget.helpers.ts (isaflow_dev, own companies).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import jobsRoute from '../../pages/api/accounting/practice/jobs';
import jobRoute from '../../pages/api/accounting/practice/jobs/[id]';
import {
  createJob,
  updateJob,
  getJob,
  JobClientHasEntriesError,
} from '@/modules/accounting/services/practice/practiceJobService';
import { JobBudgetInvalidError } from '@/modules/accounting/services/practice/practiceJobBudget';
import { listJobBudgetStatuses } from '@/modules/accounting/services/practice/practiceJobBudgetService';
import { createPracticeEntry } from '@/modules/accounting/services/practice/practiceTimeEntryService';
import { createEbFixture, ebDbAvailable, type EbFixture } from './practice-engagement-budget.helpers';

const describeIfDb = ebDbAvailable ? describe : describe.skip;

describeIfDb('Engagement budgets — the job: budgetAmount and the job/client invariant', () => {
  let f: EbFixture;
  const jobRow = async (id: string) =>
    (await f.pool.query('SELECT budget_amount, title, practice_client_id FROM practice_jobs WHERE id = $1', [id])).rows[0];

  beforeAll(async () => { f = await createEbFixture('EBJ'); });
  afterAll(async () => { if (f) await f.cleanup(); });

  describe('budgetAmount', () => {
    it('create stores it; update keeps it when absent or undefined, sets, and clears on null and \'\'', async () => {
      const job = await f.inTx(() => createJob(f.A, f.USER, { practiceClientId: f.CLIENT, title: 'EBJ created', budgetAmount: 5000 }));
      expect(job.budgetAmount).toBe(5000);
      expect((await f.inTx(() => updateJob(f.A, job.id, { title: 'EBJ renamed' }))).budgetAmount).toBe(5000);
      expect((await f.inTx(() => updateJob(f.A, job.id, { title: 'EBJ renamed', budgetAmount: undefined }))).budgetAmount).toBe(5000);
      expect((await f.inTx(() => updateJob(f.A, job.id, { budgetAmount: 7500.5 }))).budgetAmount).toBe(7500.5);
      expect((await f.inTx(() => updateJob(f.A, job.id, { budgetAmount: null }))).budgetAmount).toBeNull();
      await f.inTx(() => updateJob(f.A, job.id, { budgetAmount: 1 }));
      expect((await f.inTx(() => updateJob(f.A, job.id, { budgetAmount: '' as never }))).budgetAmount).toBeNull();
    });

    it('accepts the largest amount and keeps its cents; refuses 10^13', async () => {
      const id = await f.job(f.A, f.CLIENT, 'EBJ big');
      const max = 9999999999999.99;
      await f.inTx(() => updateJob(f.A, id, { budgetAmount: max }));
      expect((await jobRow(id)).budget_amount).toBe('9999999999999.99');
      const [s] = await f.inTx(() => listJobBudgetStatuses(f.A, { jobId: id }));
      expect(s).toMatchObject({ budgetAmount: max, balance: max, state: 'ok' });
      await f.entry({ job: id, hours: 1, rate: 0.01 });
      await f.entry({ job: id, hours: 1, rate: max });
      const [over] = await f.inTx(() => listJobBudgetStatuses(f.A, { jobId: id }));
      expect(over).toMatchObject({ balance: -0.01, state: 'over' });
      await expect(f.inTx(() => updateJob(f.A, id, { budgetAmount: 1e13 }))).rejects.toBeInstanceOf(JobBudgetInvalidError);
    });

    describe('through the routes', () => {
      let id = '';
      beforeAll(async () => { id = await f.job(f.A, f.CLIENT, 'EBJ route', { budget: 10000 }); });

      it.each([['a string', '100'], ['a negative', -0.01], ['huge', 1e300], ['10^13', 1e13], ['a boolean', true], ['an object', {}]])(
        'PUT refuses %s with 400, its own message, and changes nothing', async (_l, budgetAmount) => {
          const r = await f.call(jobRoute, 'PUT', { budgetAmount, title: 'EBJ should not rename' }, { id });
          expect(r.statusCode, JSON.stringify(r.body)).toBe(400);
          expect(r.body.error?.message).toMatch(/Engagement budget must be an amount/);
          expect(await jobRow(id)).toMatchObject({ budget_amount: '10000.00', title: 'EBJ route' });
        });

      it('POST refuses a negative budget with 400 and its message, creating nothing', async () => {
        const r = await f.call(jobsRoute, 'POST', { practiceClientId: f.CLIENT, title: 'EBJ bad create', budgetAmount: -5 });
        expect(r.statusCode).toBe(400);
        expect(r.body.error?.message).toMatch(/Engagement budget must be an amount/);
        expect(Number((await f.pool.query("SELECT count(*) AS n FROM practice_jobs WHERE company_id = $1 AND title = 'EBJ bad create'",
          [f.A])).rows[0].n)).toBe(0);
      });

      it('POST and PUT store a valid budget', async () => {
        const c = await f.call(jobsRoute, 'POST', { practiceClientId: f.CLIENT, title: 'EBJ good create', budgetAmount: 1234.56 });
        expect(c.statusCode, JSON.stringify(c.body)).toBe(201);
        expect((c.body.data as { budgetAmount: number }).budgetAmount).toBe(1234.56);
        const u = await f.call(jobRoute, 'PUT', { budgetAmount: 2000 }, { id });
        expect(u.statusCode, JSON.stringify(u.body)).toBe(200);
        expect((await jobRow(id)).budget_amount).toBe('2000.00');
      });

      it.each([['null', null], ['an array', []]])('answers a body that is %s with 400', async (_l, body) => {
        for (const r of [await f.call(jobRoute, 'PUT', body, { id }), await f.call(jobsRoute, 'POST', body)]) {
          expect(r.statusCode).toBe(400);
          expect(r.body.error?.message).toBe('Request body must be a JSON object');
        }
      });
    });
  });

  describe('a job with time entries stays with its client (migration 851)', () => {
    const base = () => ({ entryDate: '2026-01-12', hours: 1, practiceClientId: f.CLIENT, jobCategoryId: f.CAT, workItemId: f.ITEM });

    it('updateJob refuses the move with JobClientHasEntriesError and the transaction stays usable', async () => {
      const id = await f.job(f.A, f.CLIENT, 'EBJ move', { budget: 10000 });
      await f.inTx(() => createPracticeEntry(f.A, f.USER, { ...base(), taskDescription: 'EBJ move entry', jobId: id }));
      const after = await f.inTx(async () => {
        await expect(updateJob(f.A, id, { practiceClientId: f.CLIENT2 })).rejects.toBeInstanceOf(JobClientHasEntriesError);
        return getJob(f.A, id);
      });
      expect(after?.practiceClientId).toBe(f.CLIENT);
      expect((await jobRow(id)).practice_client_id).toBe(f.CLIENT);
    });

    it('PUT /jobs/[id] answers the move with 400 and its message; CLIENT2\'s budget gains nothing', async () => {
      const id = await f.job(f.A, f.CLIENT, 'EBJ move route', { budget: 10000 });
      await f.inTx(() => createPracticeEntry(f.A, f.USER, { ...base(), hours: 3, taskDescription: 'EBJ move route entry', jobId: id }));
      const put = await f.call(jobRoute, 'PUT', { practiceClientId: f.CLIENT2 }, { id });
      expect(put.statusCode).toBe(400);
      expect(put.body.error?.message).toMatch(/time entries for its current client/);
      const rows = await f.inTx(() => listJobBudgetStatuses(f.A, { practiceClientId: f.CLIENT2 }));
      expect(rows.map((r) => r.jobId)).not.toContain(id);
      expect((await jobRow(id)).practice_client_id).toBe(f.CLIENT);
    });

    it('a job with no time entries still moves', async () => {
      const id = await f.job(f.A, f.CLIENT, 'EBJ empty move');
      const moved = await f.inTx(() => updateJob(f.A, id, { practiceClientId: f.CLIENT2 }));
      expect(moved.practiceClientId).toBe(f.CLIENT2);
    });

    it('the database refuses an entry whose job is another client\'s or another company\'s', async () => {
      const id = await f.job(f.A, f.CLIENT, 'EBJ fk');
      await expect(f.entry({ client: f.CLIENT2, job: id, hours: 1, rate: 1000 })).rejects.toMatchObject({
        code: '23503', constraint: 'time_entries_job_same_client_fkey',
      });
      await expect(f.entry({ company: f.B, client: f.CLIENT_B, job: id, hours: 1, rate: 1000 })).rejects.toMatchObject({
        code: '23503', constraint: 'time_entries_job_same_client_fkey',
      });
    });
  });
});
