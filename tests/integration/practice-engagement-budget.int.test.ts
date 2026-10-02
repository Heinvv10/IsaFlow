// tests/integration/practice-engagement-budget.int.test.ts
//
// Engagement Budgets (migration 850). A firm partner asked how much of the
// approved value of an engagement is still available to spend on time. The
// budget is `practice_jobs.budget_amount`; consumption is every time entry on
// that job in the same company EXCEPT `leave`, valued at hours × applied_rate —
// drafts, submitted, approved, billed, invoiced, non-billable and written-off
// time all count. A NULL rate adds hours but no rand.
//
// It also covers the gap that made the budget meaningless: `jobId` on a time
// entry was accepted and never written. It is now written on create and update,
// fenced to the entry's own company AND practice client.
//
// Runs against isaflow_dev (allow-listed by assertNotProductionDb) with
// random-UUID companies, removed in afterAll. Fixture rows are written by the
// owner role; the service calls run inside a transaction carried by `als`, as
// withAuth runs them, and the route checks go through the real handler.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { als } from '@/lib/als';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { request, response } from './mfa-impersonation-postgres.helpers';
import timeEntriesRoute from '../../pages/api/accounting/practice/time-entries';
import budgetsRoute from '../../pages/api/accounting/practice/reports/engagement-budgets';
import {
  getJobBudgetStatus,
  listJobBudgetStatuses,
} from '@/modules/accounting/services/practice/practiceJobBudgetService';
import {
  createPracticeEntry,
  updatePracticeEntry,
} from '@/modules/accounting/services/practice/practiceTimeEntryService';
import { duplicatePracticeEntry } from '@/modules/accounting/services/practice/practiceTimeEntryWorkflow';
import { createJob, updateJob } from '@/modules/accounting/services/practice/practiceJobService';
import { PracticeJobNotForClientError } from '@/modules/accounting/services/practice/practiceClientFence';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;

const A = randomUUID();
const B = randomUUID();
const USER = randomUUID();
const CLIENT = randomUUID();
const CLIENT2 = randomUUID();
const CLIENT_B = randomUUID();
const CAT = randomUUID();
const ITEM = randomUUID();
const CAT_B = randomUUID();
const ITEM_B = randomUUID();
const JOB = randomUUID();        // budget 10 000, 20h
const JOB_OTHER = randomUUID();  // same client, no budget; its time must not leak into JOB
const JOB_NONE = randomUUID();   // no budget, has time
const JOB_WARN = randomUUID();   // budget 1 000, exactly 80% used
const JOB_OVER = randomUUID();   // budget 500, 1 000 used
const JOB_CLIENT2 = randomUUID();
const JOB_B = randomUUID();      // company B's job
const JOB_B_ON_A = randomUUID(); // company B's job hung off A's client (tenant-agnostic FK)

type Handler = (req: never, res: never) => Promise<unknown> | unknown;

describeIfDb('Engagement budgets — consumption, thresholds and the jobId fence', () => {
  let pool: Pool;
  let token = '';

  async function inTx<T>(fn: () => Promise<T>): Promise<T> {
    const c: PoolClient = await pool.connect();
    try {
      await c.query('BEGIN');
      const out = await als.run({ client: c, userId: USER, companyId: A, claims: {} } as never, fn);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally { c.release(); }
  }

  async function entry(company: string, client: string, cat: string, item: string, job: string | null,
    hours: number, rate: number | null, status: string, billable = true): Promise<void> {
    await pool.query(
      `INSERT INTO time_entries (company_id, user_id, entry_date, hours, practice_client_id, job_category_id,
         work_item_id, task_description, billable, applied_rate, line_total, status, job_id)
       VALUES ($1, $2, '2026-01-10', $3, $4, $5, $6, 'EB fixture', $7, $8::numeric,
         ROUND($3::numeric * $8::numeric, 2), $9, $10)`,
      [company, USER, hours, client, cat, item, billable, rate, status, job]);
  }

  const jobOf = async (entryId: string): Promise<string | null> =>
    (await pool.query('SELECT job_id FROM time_entries WHERE id = $1', [entryId])).rows[0]?.job_id ?? null;
  const entriesNamed = async (desc: string): Promise<number> =>
    Number((await pool.query('SELECT count(*) AS n FROM time_entries WHERE company_id = $1 AND task_description = $2',
      [A, desc])).rows[0].n);

  const base = { entryDate: '2026-01-12', hours: 1, practiceClientId: CLIENT, jobCategoryId: CAT, workItemId: ITEM };

  async function callRoute(handler: Handler, method: string, body: Record<string, unknown>,
    query: Record<string, string> = {}) {
    const req = request({ 'sb-access-token': token, active_company_id: A }, method) as never as
      { body: unknown; url: string; query: Record<string, string> };
    req.body = body;
    req.query = query;
    req.url = '/api/accounting/practice/engagement-budget-fixture';
    const out = response();
    await handler(req as never, out.res as never);
    return out.state as { statusCode: number; body: { data?: unknown; error?: { message?: string } } };
  }

  beforeAll(async () => {
    assertNotProductionDb('This suite writes practice clients, jobs and time entries.');
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true), ($3, $4, true)',
      [A, 'EB Co A', B, 'EB Co B']);
    await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)",
      [USER, `eb-${USER}@isaflow.test`]);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')", [A, USER]);
    await pool.query(
      `INSERT INTO practice_clients (id, company_id, legal_name, billing_model, status) VALUES
         ($1, $2, 'EB Client', 'hourly', 'active'), ($3, $2, 'EB Client 2', 'hourly', 'active'),
         ($4, $5, 'EB Client B', 'hourly', 'active')`,
      [CLIENT, A, CLIENT2, CLIENT_B, B]);
    await pool.query('INSERT INTO practice_job_categories (id, company_id, name) VALUES ($1, $2, $3), ($4, $5, $6)',
      [CAT, A, 'EB cat', CAT_B, B, 'EB cat B']);
    await pool.query('INSERT INTO practice_work_items (id, company_id, category_id, name) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)',
      [ITEM, A, CAT, 'EB item', ITEM_B, B, CAT_B, 'EB item B']);
    await pool.query("INSERT INTO practice_staff_rates (company_id, user_id, rate, effective_from) VALUES ($1, $2, 1000, '2020-01-01')",
      [A, USER]);
    await pool.query(
      `INSERT INTO practice_jobs (id, company_id, practice_client_id, title, budget_amount, budgeted_hours) VALUES
         ($1, $2, $3, 'EB job', 10000, 20), ($4, $2, $3, 'EB other job', NULL, NULL),
         ($5, $2, $3, 'EB no budget', NULL, 5), ($6, $2, $3, 'EB warn', 1000, NULL),
         ($7, $2, $3, 'EB over', 500, NULL), ($8, $2, $9, 'EB client 2 job', 100, NULL),
         ($10, $11, $12, 'EB B job', 999, NULL), ($13, $11, $3, 'EB B job on A client', 1, NULL)`,
      [JOB, A, CLIENT, JOB_OTHER, JOB_NONE, JOB_WARN, JOB_OVER, JOB_CLIENT2, CLIENT2, JOB_B, B, CLIENT_B, JOB_B_ON_A]);

    // JOB: 7 valued hours (one per status that counts, plus non-billable),
    // 1.5h with no rate (hours only), and 2h of leave (excluded).
    for (const status of ['draft', 'submitted', 'approved', 'billed', 'invoiced']) {
      await entry(A, CLIENT, CAT, ITEM, JOB, 1, 1000, status);
    }
    await entry(A, CLIENT, CAT, ITEM, JOB, 1, 1000, 'not_billable', false); // written off
    await entry(A, CLIENT, CAT, ITEM, JOB, 1, 1000, 'draft', false);        // non-billable
    await entry(A, CLIENT, CAT, ITEM, JOB, 1.5, null, 'draft');             // no rate
    await entry(A, CLIENT, CAT, ITEM, JOB, 2, 1000, 'leave');               // excluded
    await entry(A, CLIENT, CAT, ITEM, JOB_OTHER, 5, 1000, 'approved');      // another job
    // Company B's entry planted on A's job: the FK is tenant-agnostic.
    await entry(B, CLIENT_B, CAT_B, ITEM_B, JOB, 3, 1000, 'approved');
    await entry(A, CLIENT, CAT, ITEM, JOB_NONE, 2, 1000, 'submitted');
    await entry(A, CLIENT, CAT, ITEM, JOB_WARN, 0.8, 1000, 'approved');
    await entry(A, CLIENT, CAT, ITEM, JOB_OVER, 1, 1000, 'approved');

    token = await new SignJWT({ sub: USER, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      for (const t of ['time_entries', 'practice_jobs', 'practice_staff_rates', 'practice_work_items',
        'practice_job_categories', 'practice_clients', 'company_users']) {
        await pool.query(`DELETE FROM ${t} WHERE company_id = ANY($1::uuid[])`, [[A, B]]);
      }
      await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[A, B]]);
      await pool.query('DELETE FROM users WHERE id = $1', [USER]);
    } finally {
      await pool.end();
    }
  });

  describe('consumption', () => {
    it('counts every non-leave entry on the job at hours × rate, and only this company\'s', async () => {
      const s = await inTx(() => getJobBudgetStatus(A, JOB));
      expect(s).toEqual({
        jobId: JOB, budgetAmount: 10000, consumedAmount: 7000, balance: 3000,
        budgetedHours: 20, hoursUsed: 8.5, percentUsed: 70, state: 'ok',
      });
    });

    it('a NULL budget is state none with no balance, but still reports what was used', async () => {
      const s = await inTx(() => getJobBudgetStatus(A, JOB_NONE));
      expect(s).toMatchObject({ budgetAmount: null, consumedAmount: 2000, balance: null,
        budgetedHours: 5, hoursUsed: 2, percentUsed: null, state: 'none' });
    });

    it('80% used is a warning', async () => {
      expect(await inTx(() => getJobBudgetStatus(A, JOB_WARN)))
        .toMatchObject({ consumedAmount: 800, balance: 200, percentUsed: 80, state: 'warning' });
    });

    it('over budget is a negative balance', async () => {
      expect(await inTx(() => getJobBudgetStatus(A, JOB_OVER)))
        .toMatchObject({ consumedAmount: 1000, balance: -500, percentUsed: 200, state: 'over' });
    });

    it('another company\'s job is not found', async () => {
      expect(await inTx(() => getJobBudgetStatus(A, JOB_B))).toBeNull();
    });

    it('lists the company\'s jobs over-budget first, with the job and client named', async () => {
      const rows = await inTx(() => listJobBudgetStatuses(A, {}));
      expect(rows.map((r) => r.jobId)).not.toContain(JOB_B);
      expect(rows.map((r) => r.jobId)).not.toContain(JOB_B_ON_A);
      expect(rows[0]).toMatchObject({ jobId: JOB_OVER, title: 'EB over', practiceClientName: 'EB Client', state: 'over' });
      expect(rows[1]).toMatchObject({ jobId: JOB_WARN, state: 'warning' });
      const states = rows.map((r) => r.state);
      expect(states.indexOf('none')).toBeGreaterThan(states.lastIndexOf('ok'));
      expect(rows.find((r) => r.jobId === JOB)).toMatchObject({ consumedAmount: 7000, hoursUsed: 8.5 });
    });

    it('filters by client', async () => {
      const rows = await inTx(() => listJobBudgetStatuses(A, { practiceClientId: CLIENT2 }));
      expect(rows.map((r) => r.jobId)).toEqual([JOB_CLIENT2]);
    });
  });

  describe('job budgetAmount', () => {
    it('create stores it; update leaves it when absent, clears it on null, refuses a negative', async () => {
      const job = await inTx(() => createJob(A, USER, { practiceClientId: CLIENT, title: 'EB created', budgetAmount: 5000 }));
      expect(job.budgetAmount).toBe(5000);
      expect((await inTx(() => updateJob(A, job.id, { title: 'EB renamed' }))).budgetAmount).toBe(5000);
      expect((await inTx(() => updateJob(A, job.id, { budgetAmount: 7500.5 }))).budgetAmount).toBe(7500.5);
      await expect(inTx(() => updateJob(A, job.id, { budgetAmount: -1 }))).rejects.toThrow(/Engagement budget/);
      expect((await inTx(() => updateJob(A, job.id, { budgetAmount: null }))).budgetAmount).toBeNull();
    });
  });

  describe('jobId on time entries', () => {
    it('create writes the job when it is this client\'s', async () => {
      const e = await inTx(() => createPracticeEntry(A, USER, { ...base, taskDescription: 'EB own job', jobId: JOB_OTHER }));
      expect(e.jobId).toBe(JOB_OTHER);
      expect(await jobOf(e.id)).toBe(JOB_OTHER);
    });

    it('create treats \'\' as no job', async () => {
      const e = await inTx(() => createPracticeEntry(A, USER, { ...base, taskDescription: 'EB empty job', jobId: '' }));
      expect(await jobOf(e.id)).toBeNull();
    });

    it.each([
      ['company B\'s job', JOB_B],
      ['company B\'s job on this client', JOB_B_ON_A],
      ['a job on another of this company\'s clients', JOB_CLIENT2],
      ['a malformed id', 'not-a-uuid'],
    ])('create refuses %s with a typed error and writes nothing', async (_label, jobId) => {
      const desc = `EB refused ${jobId}`;
      await expect(inTx(() => createPracticeEntry(A, USER, { ...base, taskDescription: desc, jobId })))
        .rejects.toBeInstanceOf(PracticeJobNotForClientError);
      expect(await entriesNamed(desc)).toBe(0);
    });

    it('a refused malformed id leaves the transaction usable (the read is savepointed)', async () => {
      const out = await inTx(async () => {
        await createPracticeEntry(A, USER, { ...base, taskDescription: 'EB malformed', jobId: 'nope' })
          .catch((err: unknown) => { if (!(err instanceof PracticeJobNotForClientError)) throw err; });
        return getJobBudgetStatus(A, JOB_WARN);
      });
      expect(out?.state).toBe('warning');
    });

    it('update sets, keeps, and clears the job; refuses a foreign one', async () => {
      const e = await inTx(() => createPracticeEntry(A, USER, { ...base, taskDescription: 'EB update' }));
      expect((await inTx(() => updatePracticeEntry(A, e.id, { jobId: JOB }))).jobId).toBe(JOB);
      expect((await inTx(() => updatePracticeEntry(A, e.id, { hours: 2 }))).jobId).toBe(JOB);
      await expect(inTx(() => updatePracticeEntry(A, e.id, { jobId: JOB_B })))
        .rejects.toBeInstanceOf(PracticeJobNotForClientError);
      expect(await jobOf(e.id)).toBe(JOB);
      // Moving the entry to another client while it still names this client's job is refused.
      await expect(inTx(() => updatePracticeEntry(A, e.id, { practiceClientId: CLIENT2 })))
        .rejects.toBeInstanceOf(PracticeJobNotForClientError);
      expect((await inTx(() => updatePracticeEntry(A, e.id, { practiceClientId: CLIENT2, jobId: JOB_CLIENT2 }))).jobId)
        .toBe(JOB_CLIENT2);
      expect((await inTx(() => updatePracticeEntry(A, e.id, { jobId: '' }))).jobId).toBeNull();
    });

    it('duplicate carries the job', async () => {
      const e = await inTx(() => createPracticeEntry(A, USER, { ...base, taskDescription: 'EB dup', jobId: JOB_OTHER }));
      const d = await inTx(() => duplicatePracticeEntry(A, e.id, '2026-01-13'));
      expect(await jobOf(d.id)).toBe(JOB_OTHER);
    });

    it('the time-entries POST answers a foreign job with 400 and stores nothing; its own job with 201', async () => {
      const refused = await callRoute(timeEntriesRoute, 'POST',
        { ...base, taskDescription: 'EB route refused', jobId: JOB_B });
      expect(refused.statusCode).toBe(400);
      expect(await entriesNamed('EB route refused')).toBe(0);
      const ok = await callRoute(timeEntriesRoute, 'POST', { ...base, taskDescription: 'EB route ok', jobId: JOB });
      expect(ok.statusCode, JSON.stringify(ok.body)).toBe(201);
      expect(await entriesNamed('EB route ok')).toBe(1);
    });
  });

  describe('engagement-budgets report route', () => {
    it('returns one job\'s status, and 400 for a malformed id', async () => {
      const one = await callRoute(budgetsRoute, 'GET', {}, { jobId: JOB_WARN });
      expect(one.statusCode, JSON.stringify(one.body)).toBe(200);
      expect(one.body.data).toEqual([expect.objectContaining({ jobId: JOB_WARN, state: 'warning' })]);
      expect((await callRoute(budgetsRoute, 'GET', {}, { jobId: 'nope' })).statusCode).toBe(400);
      expect((await callRoute(budgetsRoute, 'GET', {}, { practiceClientId: 'nope' })).statusCode).toBe(400);
    });
  });
});
