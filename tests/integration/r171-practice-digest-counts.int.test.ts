// tests/integration/r171-practice-digest-counts.int.test.ts
//
// R-171. `runDailyDigest` (src/modules/accounting/services/practice/
// practiceNotificationService.ts) incremented `recipientsNotified` whether or
// not `sendEmail` succeeded: the counter in the cron's JSON response overstated
// delivery. A recipient whose send returned `{ success: false }` was still
// counted as notified — only a thrown error was (accidentally) excluded, since
// the increment sat after the send in the same try block.
//
// Driven through the real cron handler (POST /api/cron/practice/daily-reminders)
// on a disposable fixture, as the pool role — same harness as R-162
// (tests/integration/r162-practice-daily-digest.int.test.ts). sendEmail is
// mocked at module scope and never actually sends; it is scripted per
// recipient to succeed, return a soft failure, or throw, and succeeds for
// everyone else (any other company the cron also emails in this same run).
//
// The digest scans every active company (`loadActiveCompanies` has no
// company filter), so `recipientsNotified`/`recipientsFailed` on the response
// are GLOBAL totals across the whole fixture — including whatever ambient
// companies the schema dump carries, and any other suite's rows present at
// the same instant under vitest's default file parallelism (e.g. r162 also
// drives this cron). A hardcoded expected total flaked here for exactly that
// reason (review round 1: `expected 6 to be 1`, then `expected 3 to be 1` on
// a retry). Fixed by deriving the expectation from THIS run's own mock
// ledger instead of a fixed number: every recipient the cron emails in this
// process goes through this file's `sendEmailMock` (the only sendEmail this
// module graph has), so classifying each recorded outcome ourselves gives
// the exact count regardless of how many other companies/users were also
// processed. `outcomes` is cleared right before the call so nothing earlier
// pollutes it. The company- and error-scoped checks are exact regardless,
// since they filter by this test's own company id.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { assertDisposable, response } from './mfa-impersonation-postgres.helpers';

const EMAIL_SUCCESS = 'r171-success@isaflow.test';
const EMAIL_FAIL = 'r171-fail@isaflow.test';
const EMAIL_THROW = 'r171-throw@isaflow.test';

type Outcome = 'success' | 'fail' | 'throw';
const outcomes = vi.hoisted(() => [] as Outcome[]);
const sent = vi.hoisted(() => [] as Array<{ to: string; companyId: string }>);
vi.mock('@/modules/accounting/services/core/emailService', () => ({
  sendEmail: vi.fn(async (o: { to: string; subject: string; html: string; _log: { companyId: string } }) => {
    if (o.to === 'r171-throw@isaflow.test') {
      outcomes.push('throw');
      throw new Error('r171 simulated SMTP crash');
    }
    sent.push({ to: o.to, companyId: o._log.companyId });
    if (o.to === 'r171-fail@isaflow.test') {
      outcomes.push('fail');
      return { success: false, error: 'r171 simulated SMTP timeout' };
    }
    // Succeeds for our own success user AND for anyone else the cron emails
    // in this run (another company's qualifying recipient) — see header.
    outcomes.push('success');
    return { success: true };
  }),
}));

import dailyReminders from '../../pages/api/cron/practice/daily-reminders';
import { sendEmail } from '@/modules/accounting/services/core/emailService';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.ISAFLOW_DISPOSABLE_AUTH_TEST === '1' ? describe : describe.skip;

const COMPANY = randomUUID();
const U_SUCCESS = randomUUID();
const U_FAIL = randomUUID();
const U_THROW = randomUUID();
const CRON_KEY = randomUUID();
const USERS = [
  [U_SUCCESS, EMAIL_SUCCESS],
  [U_FAIL, EMAIL_FAIL],
  [U_THROW, EMAIL_THROW],
] as const;

type DigestBody = {
  data: {
    recipientsNotified: number;
    recipientsFailed: number;
    errors: Array<{ companyId: string; userId: string; error: string }>;
  };
};

describeIfDb('R-171 — practice daily digest: recipientsNotified counts only successful sends', () => {
  let pool: Pool;
  let status = 0;
  let body: unknown;
  let expectedNotified = NaN;
  let expectedFailed = NaN;

  beforeAll(async () => {
    assertDisposable();
    for (const k of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']) delete process.env[k];
    expect(vi.isMockFunction(sendEmail)).toBe(true);
    process.env.CRON_SECRET = CRON_KEY;
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });

    await pool.query(
      `INSERT INTO companies (id, name, is_active, status, suspended_at) VALUES ($1, 'R171 Co', true, 'active', NULL)`,
      [COMPANY]);
    for (const [id, email] of USERS) {
      await pool.query(
        `INSERT INTO users (id, email, first_name, role, is_active, status, suspended_at)
         VALUES ($1, $2, 'R171', 'admin', true, 'active', NULL)`, [id, email]);
      await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')", [COMPANY, id]);
      // One overdue task each, so every user has something to report — the
      // digest reaches all three regardless of what their SEND does.
      await pool.query(
        `INSERT INTO practice_tasks (company_id, job_id, assigned_to, title, status, due_date)
         VALUES ($1, NULL, $2, 'R171 overdue task', 'pending', CURRENT_DATE - 5)`, [COMPANY, id]);
    }

    const req = { method: 'POST', url: '/api/cron/practice/daily-reminders', query: {}, cookies: {},
      headers: { 'x-cron-secret': CRON_KEY }, socket: { remoteAddress: '127.0.0.171' } };
    const out = response();
    // A Wednesday, so "yesterday" is a weekday and the timesheet check runs
    // whatever day CI runs on — matches R-162's pin.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-30T05:00:00Z'));
    outcomes.length = 0; // clear before the one invocation this test scores
    try {
      await dailyReminders(req as never, out.res as never);
    } finally {
      vi.useRealTimers();
    }
    status = out.state.statusCode;
    body = out.state.body;
    expectedNotified = outcomes.filter((o) => o === 'success').length;
    expectedFailed = outcomes.filter((o) => o === 'fail' || o === 'throw').length;
  }, 300_000);

  afterAll(async () => {
    if (!pool) return;
    try {
      await pool.query('DELETE FROM practice_tasks WHERE company_id = $1', [COMPANY]);
      await pool.query('DELETE FROM company_users WHERE company_id = $1', [COMPANY]);
      await pool.query('DELETE FROM companies WHERE id = $1', [COMPANY]);
      await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [[U_SUCCESS, U_FAIL, U_THROW]]);
    } finally {
      await pool.end();
    }
  });

  it('runs to completion: 200', () => {
    expect(status, JSON.stringify(body)).toBe(200);
  });

  it('recipientsNotified/recipientsFailed exactly match this run\'s own sendEmail outcomes', () => {
    const data = (body as DigestBody).data;
    // Sanity: our 3 users must actually be in the ledger (proves the derived
    // expectation isn't vacuously 0/0 — see the "at least our 3" check below).
    expect(expectedNotified).toBeGreaterThanOrEqual(1);
    expect(expectedFailed).toBeGreaterThanOrEqual(2);
    expect(data.recipientsNotified).toBe(expectedNotified);
    expect(data.recipientsFailed).toBe(expectedFailed);
  });

  it('both the soft failure and the throw land in errors with company and user', () => {
    const data = (body as DigestBody).data;
    const mine = data.errors.filter((e) => e.companyId === COMPANY);
    const byUser = Object.fromEntries(mine.map((e) => [e.userId, e.error]));
    expect(mine).toHaveLength(2);
    expect(byUser[U_FAIL]).toContain('r171 simulated SMTP timeout');
    expect(byUser[U_THROW]).toContain('r171 simulated SMTP crash');
  });

  it('the successful send was actually captured (never really sent)', () => {
    expect(sent.some((m) => m.to === EMAIL_SUCCESS && m.companyId === COMPANY)).toBe(true);
    // The throwing recipient's send is never recorded as sent (it threw before the push).
    expect(sent.some((m) => m.to === EMAIL_THROW)).toBe(false);
  });
});
