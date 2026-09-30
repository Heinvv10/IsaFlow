// tests/integration/r168-practice-recurring-sweep.int.test.ts
//
// R-168. The practice recurring-task cron (POST /api/cron/practice/recurring-tasks
// → sweepRecurringTasks) selected `companies.deleted_at`, a column that exists
// nowhere, so every run died on its first query. Behind that, the sweep copied
// the source task's job and assignee as they were: a company-A task hanging off
// B's job, or assigned to someone outside A, was re-created that way every
// period. The cron has no withAuth and runs on the pool's own role, past RLS.
//
// Driven through the real cron handler on a disposable fixture, as the pool
// role. Every source task the sweep must refuse or rewrite is otherwise
// eligible, so each outcome is decided by the predicate under test.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { assertDisposable, response } from './mfa-impersonation-postgres.helpers';
import { cleanup, cronRequest, fixtureCompanies, seedCompanies, seedUser } from './r168-practice-crons.helpers';
import recurringTasks from '../../pages/api/cron/practice/recurring-tasks';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.ISAFLOW_DISPOSABLE_AUTH_TEST === '1' ? describe : describe.skip;

const C = fixtureCompanies();
const COMPANIES = Object.values(C);
const U = {
  a: randomUUID(), aInactive: randomUUID(), aSuspendedAt: randomUUID(), aStatus: randomUUID(), b: randomUUID(),
  deleted: randomUUID(), suspended: randomUUID(), suspendedAt: randomUUID(),
};
const S = {
  own: randomUUID(), foreignJob: randomUUID(), assigneeB: randomUUID(), assigneeInactive: randomUUID(),
  assigneeSuspendedAt: randomUUID(), assigneeStatus: randomUUID(), creatorB: randomUUID(),
  creatorSuspendedAt: randomUUID(), creatorNull: randomUUID(), inB: randomUUID(),
  deleted: randomUUID(), suspended: randomUUID(), suspendedAt: randomUUID(),
};
const CLIENT_A = randomUUID();
const CLIENT_B = randomUUID();
const JOB_A = randomUUID();
const JOB_B = randomUUID();
const CRON_KEY = randomUUID();

interface Sweep { tasksGenerated: number; tasksSkipped: number; errors: Array<{ companyId: string }> }
interface Child { parent_task_id: string; company_id: string; job_id: string | null; assigned_to: string | null;
  created_by: string | null; status: string; title: string; due_ok: boolean }

async function runSweep(): Promise<{ status: number; data: Sweep; body: unknown }> {
  const out = response();
  await recurringTasks(cronRequest('/api/cron/practice/recurring-tasks', CRON_KEY) as never, out.res as never);
  return { status: out.state.statusCode, data: (out.state.body as { data: Sweep }).data, body: out.state.body };
}

describeIfDb('R-168 — practice recurring sweep: runs, and never links a task to another company or an outsider', () => {
  let pool: Pool;
  let first: Awaited<ReturnType<typeof runSweep>>;
  let children: Child[] = [];
  const childOf = (src: string) => children.filter((c) => c.parent_task_id === src);
  const loadChildren = async () => (await pool.query<Child>(
    `SELECT c.parent_task_id, c.company_id, c.job_id, c.assigned_to::text, c.created_by::text, c.status, c.title,
            c.due_date = (s.due_date + INTERVAL '1 month')::date AS due_ok
       FROM practice_tasks c JOIN practice_tasks s ON s.id = c.parent_task_id
      WHERE c.company_id = ANY($1::uuid[])`, [COMPANIES])).rows;

  beforeAll(async () => {
    assertDisposable();
    process.env.CRON_SECRET = CRON_KEY;
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });

    await seedCompanies(pool, 'R168S', C);
    await seedUser(pool, U.a, `r168-${U.a}@isaflow.test`, [C.A], 'R168');
    await seedUser(pool, U.aInactive, `r168-${U.aInactive}@isaflow.test`, [C.A], 'R168', { active: false });
    await seedUser(pool, U.aSuspendedAt, `r168-${U.aSuspendedAt}@isaflow.test`, [C.A], 'R168', { suspended: true });
    await seedUser(pool, U.aStatus, `r168-${U.aStatus}@isaflow.test`, [C.A], 'R168', { status: 'suspended' });
    await seedUser(pool, U.b, `r168-${U.b}@isaflow.test`, [C.B], 'R168');
    await seedUser(pool, U.deleted, `r168-${U.deleted}@isaflow.test`, [C.DELETED], 'R168');
    await seedUser(pool, U.suspended, `r168-${U.suspended}@isaflow.test`, [C.SUSPENDED], 'R168');
    await seedUser(pool, U.suspendedAt, `r168-${U.suspendedAt}@isaflow.test`, [C.SUSPENDED_AT], 'R168');

    await pool.query(
      `INSERT INTO practice_clients (id, company_id, legal_name) VALUES ($1, $2, 'R168 Client A'), ($3, $4, 'R168 Client B')`,
      [CLIENT_A, C.A, CLIENT_B, C.B]);
    await pool.query(
      `INSERT INTO practice_jobs (id, company_id, practice_client_id, title) VALUES ($1, $2, $3, 'R168 Job A'), ($4, $5, $6, 'R168 Job B')`,
      [JOB_A, C.A, CLIENT_A, JOB_B, C.B, CLIENT_B]);
    // A resolved, overdue monthly task: exactly what the sweep picks up.
    const source = (id: string, company: string, job: string | null, assignee: string | null, creator: string | null) =>
      pool.query(
        `INSERT INTO practice_tasks (id, company_id, job_id, title, assigned_to, created_by, status, recurring_rule, due_date)
         VALUES ($1, $2, $3, $6, $4, $5, 'done', 'monthly', CURRENT_DATE - 10)`,
        [id, company, job, assignee, creator, `R168 recurring ${id}`]);
    await source(S.own, C.A, JOB_A, U.a, U.a);
    await source(S.foreignJob, C.A, JOB_B, U.a, U.a);
    await source(S.assigneeB, C.A, JOB_A, U.b, U.a);
    await source(S.assigneeInactive, C.A, JOB_A, U.aInactive, U.a);
    await source(S.assigneeSuspendedAt, C.A, JOB_A, U.aSuspendedAt, U.a);
    await source(S.assigneeStatus, C.A, JOB_A, U.aStatus, U.a);
    await source(S.creatorB, C.A, JOB_A, U.a, U.b);
    await source(S.creatorSuspendedAt, C.A, JOB_A, U.a, U.aSuspendedAt);
    await source(S.creatorNull, C.A, JOB_A, U.a, null);
    await source(S.inB, C.B, JOB_B, U.b, U.b);
    await source(S.deleted, C.DELETED, null, U.deleted, U.deleted);
    await source(S.suspended, C.SUSPENDED, null, U.suspended, U.suspended);
    await source(S.suspendedAt, C.SUSPENDED_AT, null, U.suspendedAt, U.suspendedAt);

    first = await runSweep();
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    children = await loadChildren();
  }, 300_000);

  afterAll(async () => {
    if (!pool) return;
    try {
      await pool.query('DELETE FROM practice_tasks WHERE company_id = ANY($1::uuid[]) AND parent_task_id IS NOT NULL', [COMPANIES]);
      await cleanup(pool, COMPANIES, Object.values(U), ['practice_tasks', 'practice_jobs', 'practice_clients']);
    } finally {
      await pool.end();
    }
  });

  it('runs to completion: 200, and no error for the fixture companies', () => {
    expect(first.data.errors.filter((e) => COMPANIES.includes(e.companyId))).toEqual([]);
  });

  it('a clean source gets its next instance: same job and assignee, pending, due one period on', () => {
    expect(childOf(S.own)).toEqual([{ parent_task_id: S.own, company_id: C.A, job_id: JOB_A, assigned_to: U.a,
      created_by: U.a, status: 'pending', title: `R168 recurring ${S.own}`, due_ok: true }]);
  });

  it('B\'s own recurring task is generated in B', () => {
    expect(childOf(S.inB).map((c) => [c.company_id, c.job_id, c.assigned_to])).toEqual([[C.B, JOB_B, U.b]]);
  });

  it('a source on B\'s job gets an instance with no job, keeping its own assignee', () => {
    expect(childOf(S.foreignJob).map((c) => [c.job_id, c.assigned_to])).toEqual([[null, U.a]]);
  });

  it('an assignee from another company is dropped', () => {
    expect(childOf(S.assigneeB).map((c) => [c.job_id, c.assigned_to])).toEqual([[JOB_A, null]]);
  });
  it('an inactive assignee is dropped', () => expect(childOf(S.assigneeInactive).map((c) => c.assigned_to)).toEqual([null]));
  it('an assignee with suspended_at set is dropped',
    () => expect(childOf(S.assigneeSuspendedAt).map((c) => c.assigned_to)).toEqual([null]));
  it('an assignee whose status is not active is dropped',
    () => expect(childOf(S.assigneeStatus).map((c) => c.assigned_to)).toEqual([null]));

  it('skips a source created by another company\'s member', () => expect(childOf(S.creatorB)).toEqual([]));
  it('skips a source whose creator has suspended_at set', () => expect(childOf(S.creatorSuspendedAt)).toEqual([]));
  it('skips a source with no creator', () => expect(childOf(S.creatorNull)).toEqual([]));
  it('counts the skipped sources', () => expect(first.data.tasksSkipped).toBeGreaterThanOrEqual(3));

  it('skips a deleted company', () => expect(childOf(S.deleted)).toEqual([]));
  it('skips a company with status suspended', () => expect(childOf(S.suspended)).toEqual([]));
  it('skips a company with suspended_at set', () => expect(childOf(S.suspendedAt)).toEqual([]));

  it('no generated task links another company\'s job or an assignee outside the company\'s members in good standing', async () => {
    const bad = await pool.query(
      `SELECT c.id FROM practice_tasks c
        WHERE c.company_id = ANY($1::uuid[]) AND c.parent_task_id IS NOT NULL
          AND ((c.job_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM practice_jobs j WHERE j.id = c.job_id AND j.company_id = c.company_id))
            OR (c.assigned_to IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM company_users cu JOIN users u ON u.id = cu.user_id
                   WHERE cu.company_id = c.company_id AND cu.user_id = c.assigned_to::text
                     AND u.is_active AND u.suspended_at IS NULL AND (u.status IS NULL OR lower(u.status) = 'active'))))`,
      [COMPANIES]);
    expect(children.length).toBe(7);
    expect(bad.rows).toEqual([]);
  });

  it('stays idempotent: a second run generates nothing', async () => {
    const second = await runSweep();
    expect(second.status).toBe(200);
    expect(second.data.tasksGenerated).toBe(0);
    expect((await loadChildren()).length).toBe(children.length);
  });
});
