// tests/integration/practice-engagement-budget-races.int.test.ts
//
// Engagement Budgets: what the fence's read cannot see. The fence reads the
// job without a lock, so a job moved to another client between that read and
// the write reaches migration 851's FK as a 23503. The write runs in a
// savepoint and that 23503 becomes PracticeJobNotForClientError (400), and
// bulk gives each date its own savepoint so one refused date cannot poison
// the rest or put Postgres text in the 201 body. Also: an uppercase copy of
// the entry's own job id is not a "new link", and updateJob maps only 851's
// 23503 — any other error is re-thrown as it is.
// Fixture: practice-engagement-budget.helpers.ts (isaflow_dev, own companies).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import timeEntriesRoute from '../../pages/api/accounting/practice/time-entries';
import entryRoute from '../../pages/api/accounting/practice/time-entries/[id]';
import bulkRoute from '../../pages/api/accounting/practice/time-entries/bulk';
import { updatePracticeEntry } from '@/modules/accounting/services/practice/practiceTimeEntryService';
import { updateJob, JobClientHasEntriesError } from '@/modules/accounting/services/practice/practiceJobService';
import { createEbFixture, ebDbAvailable, type EbFixture } from './practice-engagement-budget.helpers';

const describeIfDb = ebDbAvailable ? describe : describe.skip;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeIfDb('Engagement budgets — a job moved mid-request, id case, and updateJob error mapping', () => {
  let f: EbFixture;
  const base = () => ({ entryDate: '2026-01-12', hours: 1, practiceClientId: f.CLIENT, jobCategoryId: f.CAT, workItemId: f.ITEM });
  const mismatched = async (job: string) => Number((await f.pool.query(
    `SELECT count(*) AS n FROM time_entries te JOIN practice_jobs pj ON pj.id = te.job_id
     WHERE te.job_id = $1 AND (te.practice_client_id IS DISTINCT FROM pj.practice_client_id OR te.company_id <> pj.company_id)`,
    [job])).rows[0].n);

  /** Another transaction moves the job to CLIENT2 and holds the row until released. */
  async function holdJobMove(job: string): Promise<PoolClient> {
    const c = await f.pool.connect();
    await c.query('BEGIN');
    await c.query('UPDATE practice_jobs SET practice_client_id = $2 WHERE id = $1', [job, f.CLIENT2]);
    return c;
  }
  async function release(c: PoolClient) { await c.query('COMMIT'); c.release(); }

  beforeAll(async () => { f = await createEbFixture('EBX'); });
  afterAll(async () => { if (f) await f.cleanup(); });

  it('POST /time-entries: the job moves after the fence read — 400, nothing written, not a 500', async () => {
    const job = await f.job(f.A, f.CLIENT, 'EBX race create');
    const t2 = await holdJobMove(job);
    const p = f.call(timeEntriesRoute, 'POST', { ...base(), taskDescription: 'EBX race create', jobId: job });
    await pause(800);
    await release(t2);
    const r = await p;
    expect(r.statusCode, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error?.message).toMatch(/was not found for this client/);
    expect(await f.entriesNamed('EBX race create')).toBe(0);
    expect(await mismatched(job)).toBe(0);
  });

  it('PUT /time-entries/[id]: the job moves after the fence read — 400 and the entry keeps no job', async () => {
    const job = await f.job(f.A, f.CLIENT, 'EBX race update');
    const id = await f.entry({ job: null, hours: 1, rate: 1000, desc: 'EBX race update' });
    const t2 = await holdJobMove(job);
    const p = f.call(entryRoute, 'PUT', { jobId: job }, { id });
    await pause(800);
    await release(t2);
    const r = await p;
    expect(r.statusCode, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error?.message).toMatch(/was not found for this client/);
    expect(await f.jobOf(id)).toBeNull();
  });

  it('bulk: a job moved mid-run refuses every date with the fence message, never Postgres text', async () => {
    const job = await f.job(f.A, f.CLIENT, 'EBX race bulk');
    const tpl = randomUUID();
    await f.pool.query(
      `INSERT INTO practice_entry_templates (id, company_id, user_id, name, practice_client_id, job_category_id,
         work_item_id, default_hours, task_description, billable)
       VALUES ($1, $2, $3, 'EBX tpl', $4, $5, $6, 2, 'EBX race bulk', true)`,
      [tpl, f.A, f.USER, f.CLIENT, f.CAT, f.ITEM]);
    const t2 = await holdJobMove(job);
    const p = f.call(bulkRoute, 'POST', { templateId: tpl, dateFrom: '2026-01-05', dateTo: '2026-01-07', weekdays: [1, 2, 3], jobId: job });
    await pause(800);
    await release(t2);
    const r = await p;
    expect(r.statusCode, JSON.stringify(r.body)).toBe(201);
    const data = r.body.data as { created: number; failed: Array<{ date: string; error: string }> };
    expect(data.created).toBe(0);
    expect(data.failed).toHaveLength(3);
    for (const fl of data.failed) expect(fl.error).toMatch(/^Job .* was not found for this client$/);
    expect(await f.entriesNamed('EBX race bulk')).toBe(0);
  });

  it('an uppercase copy of the entry\'s own (now closed) job id is not a new link', async () => {
    const job = await f.job(f.A, f.CLIENT, 'EBX case');
    const id = await f.entry({ job, hours: 1, rate: 1000, desc: 'EBX case' });
    await f.pool.query("UPDATE practice_jobs SET status = 'complete' WHERE id = $1", [job]);
    const e = await f.inTx(() => updatePracticeEntry(f.A, id, { hours: 2, jobId: job.toUpperCase() }));
    expect(e.jobId).toBe(job);
  });

  it('updateJob re-throws an error that is not 851\'s 23503, unmapped', async () => {
    const job = await f.job(f.A, f.CLIENT, 'EBX overflow');
    // budgeted_hours is NUMERIC(8,2): 10^7 overflows (22003) inside the savepointed UPDATE.
    const err = await f.inTx(() => updateJob(f.A, job, { budgetedHours: 1e7 })).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(JobClientHasEntriesError);
    expect(err).toMatchObject({ code: '22003' });
  });
});
