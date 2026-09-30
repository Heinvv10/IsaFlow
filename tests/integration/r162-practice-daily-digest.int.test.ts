// tests/integration/r162-practice-daily-digest.int.test.ts
//
// R-162. The practice daily-digest cron (POST /api/cron/practice/daily-reminders
// → runDailyDigest) selected `companies.deleted_at`, a column that exists
// nowhere, so every run died on its first query. Behind that, queryOverdueTasks
// joined practice_tasks → practice_jobs → practice_clients with no company
// predicate. The cron has no withAuth: it runs on the pool's own role, which
// reads past RLS, so once the first query worked, a company-A task hanging off
// company B's job — or A's job re-pointed at B's client — printed B's job title
// or client name in A's email.
//
// Driven through the real cron handler on a disposable fixture, as the pool
// role. The mailer is the only seam replaced: sendEmail is captured, never
// sent. Every user the digest must NOT reach has an overdue task, so each
// refusal is decided by the predicate under test and not by "nothing to say".

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { assertDisposable, response } from './mfa-impersonation-postgres.helpers';

const sent = vi.hoisted(() => [] as Array<{ to: string; subject: string; html: string; companyId: string }>);
vi.mock('@/modules/accounting/services/core/emailService', () => ({
  sendEmail: vi.fn(async (o: { to: string; subject: string; html: string; _log: { companyId: string } }) => {
    sent.push({ to: o.to, subject: o.subject, html: o.html, companyId: o._log.companyId });
    return { success: true };
  }),
}));

import dailyReminders from '../../pages/api/cron/practice/daily-reminders';
import { sendEmail } from '@/modules/accounting/services/core/emailService';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.ISAFLOW_DISPOSABLE_AUTH_TEST === '1' ? describe : describe.skip;

const A = randomUUID();
const B = randomUUID();
const DELETED = randomUUID();
const SUSPENDED = randomUUID();
const SUSPENDED_AT = randomUUID();
const COMPANIES = [A, B, DELETED, SUSPENDED, SUSPENDED_AT];

const U = {
  a: randomUUID(), b: randomUUID(), aInactive: randomUUID(), aSuspendedAt: randomUUID(),
  aStatus: randomUUID(), deleted: randomUUID(), suspended: randomUUID(), suspendedAt: randomUUID(),
  both: randomUUID(),
  // users.id is VARCHAR; dev carries non-UUID ids, and a ::UUID cast of one aborted that user's digest.
  textId: `r162-text-id-${randomUUID()}`,
};
const email = (id: string) => `r162-${id}@isaflow.test`;

const CLIENT_A = randomUUID();
const CLIENT_B = randomUUID();
const JOB_A = randomUUID();
const JOB_A_ON_B_CLIENT = randomUUID();
const JOB_B = randomUUID();

const CRON_KEY = randomUUID();

describeIfDb('R-162 — practice daily digest: runs, and never shows another company\'s data', () => {
  let pool: Pool;
  let status = 0;
  let body: unknown;
  const mine = () => sent.filter((m) => COMPANIES.includes(m.companyId));
  const digestTo = (userId: string) => mine().filter((m) => m.to === email(userId));

  beforeAll(async () => {
    assertDisposable();
    for (const k of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']) delete process.env[k];
    expect(vi.isMockFunction(sendEmail)).toBe(true);
    process.env.CRON_SECRET = CRON_KEY;
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });

    await pool.query(
      `INSERT INTO companies (id, name, is_active, status, suspended_at) VALUES
         ($1, 'R162 Co A', true, 'active', NULL), ($2, 'R162 Co B', true, 'active', NULL),
         ($3, 'R162 Co deleted', true, 'deleted', NULL), ($4, 'R162 Co suspended', true, 'suspended', NULL),
         ($5, 'R162 Co suspended_at', true, 'active', NOW())`,
      [A, B, DELETED, SUSPENDED, SUSPENDED_AT]);
    const users: Array<[string, string, boolean, string | null, boolean]> = [
      [U.a, A, true, 'active', false], [U.b, B, true, 'active', false],
      [U.aInactive, A, false, 'active', false], [U.aSuspendedAt, A, true, 'active', true],
      [U.aStatus, A, true, 'suspended', false], [U.deleted, DELETED, true, 'active', false],
      [U.suspended, SUSPENDED, true, 'active', false], [U.suspendedAt, SUSPENDED_AT, true, 'active', false],
      [U.both, A, true, 'active', false], [U.textId, A, true, 'active', false],
    ];
    for (const [id, company, active, st, susp] of users) {
      await pool.query(
        `INSERT INTO users (id, email, first_name, role, is_active, status, suspended_at)
         VALUES ($1, $2, 'R162', 'admin', $3, $4, CASE WHEN $5 THEN NOW() END)`,
        [id, email(id), active, st, susp]);
      await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')", [company, id]);
    }
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')", [B, U.both]);
    await pool.query(
      `INSERT INTO practice_clients (id, company_id, legal_name) VALUES
         ($1, $2, 'R162 Client A'), ($3, $4, 'R162 SECRET CLIENT B')`,
      [CLIENT_A, A, CLIENT_B, B]);
    // JOB_A_ON_B_CLIENT is the row R-073 closed the write for: A's job pointing at B's client.
    await pool.query(
      `INSERT INTO practice_jobs (id, company_id, practice_client_id, title) VALUES
         ($1, $2, $3, 'R162 Job A'), ($4, $2, $5, 'R162 Job A on B client'), ($6, $7, $5, 'R162 SECRET JOB B')`,
      [JOB_A, A, CLIENT_A, JOB_A_ON_B_CLIENT, CLIENT_B, JOB_B, B]);
    const task = (company: string, job: string | null, user: string, title: string) => pool.query(
      `INSERT INTO practice_tasks (company_id, job_id, assigned_to, title, status, due_date)
       VALUES ($1, $2, $3, $4, 'pending', CURRENT_DATE - 5)`, [company, job, user, title]);
    await task(A, JOB_A, U.a, 'R162 task on own job');
    await task(A, JOB_A_ON_B_CLIENT, U.a, 'R162 task on job pointing at B client');
    await task(A, JOB_B, U.a, 'R162 task pointing at B job');
    await task(B, JOB_B, U.b, 'R162 B task');
    await task(A, JOB_A, U.both, 'R162 dual-member task in A');
    await task(B, JOB_B, U.both, 'R162 dual-member task in B');
    for (const u of [U.aInactive, U.aSuspendedAt, U.aStatus]) await task(A, JOB_A, u, 'R162 task for a user out of standing');
    await task(DELETED, null, U.deleted, 'R162 task in deleted company');
    await task(SUSPENDED, null, U.suspended, 'R162 task in suspended company');
    await task(SUSPENDED_AT, null, U.suspendedAt, 'R162 task in suspended_at company');

    const req = { method: 'POST', url: '/api/cron/practice/daily-reminders', query: {}, cookies: {},
      headers: { 'x-cron-secret': CRON_KEY }, socket: { remoteAddress: '127.0.0.162' } };
    const out = response();
    // A Wednesday, so "yesterday" is a weekday and the timesheet check runs whatever day CI runs on.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-30T05:00:00Z'));
    try {
      await dailyReminders(req as never, out.res as never);
    } finally {
      vi.useRealTimers();
    }
    status = out.state.statusCode;
    body = out.state.body;
  }, 300_000);

  afterAll(async () => {
    if (!pool) return;
    try {
      for (const t of ['practice_tasks', 'practice_jobs', 'practice_clients', 'company_users']) {
        await pool.query(`DELETE FROM ${t} WHERE company_id = ANY($1::uuid[])`, [COMPANIES]);
      }
      await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [COMPANIES]);
      await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [Object.values(U)]);
    } finally {
      await pool.end();
    }
  });

  it('runs to completion: 200, and no per-company or per-user error for the fixture companies', () => {
    expect(status, JSON.stringify(body)).toBe(200);
    const data = (body as { data: { errors: Array<{ companyId: string }> } }).data;
    expect(data.errors.filter((e) => COMPANIES.includes(e.companyId))).toEqual([]);
  });

  it('company A\'s digest lists A\'s overdue tasks with A\'s own client and job names', () => {
    const [digest, ...extra] = digestTo(U.a);
    expect(extra).toEqual([]);
    expect(digest?.companyId).toBe(A);
    expect(digest?.html).toContain('R162 task on own job');
    expect(digest?.html).toContain('R162 Client A');
    expect(digest?.html).toContain('R162 Job A');
  });

  it('a job in A pointing at B\'s client never prints B\'s client name in A\'s digest', () => {
    const html = digestTo(U.a)[0]?.html ?? '';
    expect(html).toContain('R162 task on job pointing at B client');
    expect(html).not.toContain('SECRET CLIENT B');
  });

  it('a task in A pointing at B\'s job never prints B\'s job title in A\'s digest', () => {
    const html = digestTo(U.a)[0]?.html ?? '';
    expect(html).toContain('R162 task pointing at B job');
    expect(html).not.toContain('SECRET JOB B');
  });

  it('B\'s member gets only B\'s digest, and nothing of A\'s', () => {
    const b = digestTo(U.b);
    expect(b.map((m) => m.companyId)).toEqual([B]);
    expect(b[0]?.html).toContain('R162 B task');
    expect(b[0]?.html).not.toContain('R162 task on own job');
  });

  it('every digest for a fixture company goes to a member of that company', () => {
    const memberOf: Record<string, string[]> = {
      [email(U.a)]: [A], [email(U.b)]: [B], [email(U.aInactive)]: [A], [email(U.aSuspendedAt)]: [A],
      [email(U.aStatus)]: [A], [email(U.deleted)]: [DELETED], [email(U.suspended)]: [SUSPENDED],
      [email(U.suspendedAt)]: [SUSPENDED_AT], [email(U.both)]: [A, B], [email(U.textId)]: [A],
    };
    expect(mine().length).toBeGreaterThan(0);
    for (const m of mine()) expect(memberOf[m.to], m.to).toContain(m.companyId);
  });

  it('a member of A and B gets one digest per company, each listing only that company\'s tasks', () => {
    const byCompany = Object.fromEntries(digestTo(U.both).map((m) => [m.companyId, m.html]));
    expect(Object.keys(byCompany).sort()).toEqual([A, B].sort());
    expect(byCompany[A]).toContain('R162 dual-member task in A');
    expect(byCompany[A]).not.toContain('R162 dual-member task in B');
    expect(byCompany[B]).toContain('R162 dual-member task in B');
    expect(byCompany[B]).not.toContain('R162 dual-member task in A');
  });

  it('skips a deleted company', () => expect(digestTo(U.deleted)).toEqual([]));
  it('skips a company with status suspended', () => expect(digestTo(U.suspended)).toEqual([]));
  it('skips a company with suspended_at set', () => expect(digestTo(U.suspendedAt)).toEqual([]));
  it('skips an inactive user', () => expect(digestTo(U.aInactive)).toEqual([]));
  it('skips a user with suspended_at set', () => expect(digestTo(U.aSuspendedAt)).toEqual([]));
  it('skips a user whose status is not active', () => expect(digestTo(U.aStatus)).toEqual([]));
});
