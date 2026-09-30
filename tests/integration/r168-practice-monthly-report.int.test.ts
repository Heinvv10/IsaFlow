// tests/integration/r168-practice-monthly-report.int.test.ts
//
// R-168. The practice monthly-report cron (POST /api/cron/practice/monthly-reports
// → runMonthlyReports) selected `companies.deleted_at`, a column that exists
// nowhere, so every run died on its first query. Behind that, the report joined
// time_entries → practice_clients with no company predicate, and it mailed any
// address typed into practice_report_recipients. The cron has no withAuth: it
// runs on the pool's own role, which reads past RLS.
//
// Driven through the real cron handler on a disposable fixture, as the pool
// role. The mailer is the only seam replaced: sendEmail is captured, never sent.
// Every recipient the report must NOT reach is otherwise eligible, so each
// refusal is decided by the predicate under test.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { assertDisposable, response } from './mfa-impersonation-postgres.helpers';
import { cleanup, cronRequest, fixtureCompanies, seedCompanies, seedUser } from './r168-practice-crons.helpers';

const mail = vi.hoisted(() => ({ calls: [] as Array<{ to: string; html: string; companyId: string; ok: boolean }>, failTo: '' }));
vi.mock('@/modules/accounting/services/core/emailService', () => ({
  sendEmail: vi.fn(async (o: { to: string; html: string; _log: { companyId: string } }) => {
    const ok = o.to !== mail.failTo;
    mail.calls.push({ to: o.to, html: o.html, companyId: o._log.companyId, ok });
    return ok ? { success: true } : { success: false, error: 'R168 simulated SMTP failure' };
  }),
}));

import monthlyReports from '../../pages/api/cron/practice/monthly-reports';
import { sendEmail } from '@/modules/accounting/services/core/emailService';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.ISAFLOW_DISPOSABLE_AUTH_TEST === '1' ? describe : describe.skip;

const C = fixtureCompanies();
const FAILCO = randomUUID();
const COMPANIES = [...Object.values(C), FAILCO];
const U = {
  a: randomUUID(), a2: randomUUID(), aRowInactive: randomUUID(), aNotOptedIn: randomUUID(),
  aInactive: randomUUID(), aSuspendedAt: randomUUID(), aStatus: randomUUID(), b: randomUUID(),
  deleted: randomUUID(), suspended: randomUUID(), suspendedAt: randomUUID(), fail: randomUUID(),
};
const email = (id: string) => `r168-${id}@isaflow.test`;
const OUTSIDER = `r168-outsider-${randomUUID()}@isaflow.test`;
// Stored padded and upper-cased: the member match is case-insensitive and trimmed.
const A2_STORED = `  ${email(U.a2).toUpperCase()} `;
const CLIENT_A = randomUUID();
const CLIENT_B = randomUUID();
const CRON_KEY = randomUUID();

describeIfDb('R-168 — practice monthly report: runs, reaches only members, never shows another company\'s data', () => {
  let pool: Pool;
  let status = 0;
  let data: { recipientsEmailed: number; recipientsSkipped: number; errors: Array<{ companyId: string; email: string; error: string }> };
  const mine = () => mail.calls.filter((m) => COMPANIES.includes(m.companyId));
  const to = (company: string) => mine().filter((m) => m.companyId === company).map((m) => m.to).sort();
  const reportFor = (company: string, addr: string) => mine().find((m) => m.companyId === company && m.to === addr)?.html ?? '';

  beforeAll(async () => {
    assertDisposable();
    for (const k of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']) delete process.env[k];
    expect(vi.isMockFunction(sendEmail)).toBe(true);
    process.env.CRON_SECRET = CRON_KEY;
    mail.failTo = email(U.fail);
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });

    await seedCompanies(pool, 'R168M', C, [FAILCO]);
    await seedUser(pool, U.a, email(U.a), [C.A], 'R168 Staff A');
    await seedUser(pool, U.a2, email(U.a2), [C.A], 'R168 Staff A2');
    await seedUser(pool, U.aRowInactive, email(U.aRowInactive), [C.A], 'R168');
    await seedUser(pool, U.aNotOptedIn, email(U.aNotOptedIn), [C.A], 'R168');
    await seedUser(pool, U.aInactive, email(U.aInactive), [C.A], 'R168', { active: false });
    await seedUser(pool, U.aSuspendedAt, email(U.aSuspendedAt), [C.A], 'R168', { suspended: true });
    await seedUser(pool, U.aStatus, email(U.aStatus), [C.A], 'R168', { status: 'suspended' });
    await seedUser(pool, U.b, email(U.b), [C.B], 'R168 SECRET STAFF B');
    await seedUser(pool, U.deleted, email(U.deleted), [C.DELETED], 'R168');
    await seedUser(pool, U.suspended, email(U.suspended), [C.SUSPENDED], 'R168');
    await seedUser(pool, U.suspendedAt, email(U.suspendedAt), [C.SUSPENDED_AT], 'R168');
    await seedUser(pool, U.fail, email(U.fail), [FAILCO], 'R168');

    const recipient = (company: string, addr: string, active = true, types = '{monthly_summary}') => pool.query(
      `INSERT INTO practice_report_recipients (company_id, email, name, is_active, report_types)
       VALUES ($1, $2, 'R168 recipient', $3, $4::text[])`, [company, addr, active, types]);
    await recipient(C.A, email(U.a));
    await recipient(C.A, A2_STORED);
    await recipient(C.A, email(U.aRowInactive), false);
    await recipient(C.A, email(U.aNotOptedIn), true, '{}');
    await recipient(C.A, OUTSIDER);
    await recipient(C.A, email(U.b)); // B's member, in good standing — but not A's
    for (const u of [U.aInactive, U.aSuspendedAt, U.aStatus]) await recipient(C.A, email(u));
    await recipient(C.B, email(U.b));
    await recipient(C.DELETED, email(U.deleted));
    await recipient(C.SUSPENDED, email(U.suspended));
    await recipient(C.SUSPENDED_AT, email(U.suspendedAt));
    await recipient(FAILCO, email(U.fail));

    await pool.query(
      `INSERT INTO practice_clients (id, company_id, legal_name) VALUES ($1, $2, 'R168 Client A'), ($3, $4, 'R168 SECRET CLIENT B')`,
      [CLIENT_A, C.A, CLIENT_B, C.B]);
    const entry = (company: string, user: string, client: string, status: string, total: number, day = '2026-08-10') =>
      pool.query(
        `INSERT INTO time_entries (company_id, user_id, task_description, entry_date, hours, billable, line_total,
           status, approved_at, practice_client_id)
         VALUES ($1, $2, 'R168 entry', $6::date, 2, true, $3, $4, $6::date + 2, $5)`,
        [company, user, total, status, client, day]);
    await entry(C.A, U.a, CLIENT_A, 'billed', 1000);
    // A's entries pointing at B's client. In August: client profitability printed B's name.
    await entry(C.A, U.a, CLIENT_B, 'approved', 500);
    // Unbilled since July: WIP aging (31+ days at 31 August, the only WIP rows the email shows) printed it too.
    await entry(C.A, U.a, CLIENT_B, 'approved', 400, '2026-07-10');
    // B's member logged time in A: the name lookup is A's members only, so B's staff name never prints.
    await entry(C.A, U.b, CLIENT_A, 'approved', 300);
    await entry(C.B, U.b, CLIENT_B, 'billed', 700);

    const out = response();
    await monthlyReports(cronRequest('/api/cron/practice/monthly-reports', CRON_KEY, { reportMonth: '2026-08' }) as never, out.res as never);
    status = out.state.statusCode;
    data = (out.state.body as { data: typeof data }).data;
    expect(status, JSON.stringify(out.state.body)).toBe(200);
  }, 300_000);

  afterAll(async () => {
    if (!pool) return;
    try {
      await cleanup(pool, COMPANIES, Object.values(U), ['time_entries', 'practice_report_recipients', 'practice_clients']);
    } finally {
      await pool.end();
    }
  });

  it('runs to completion: 200, and no error for the fixture companies but the failing mailbox', () => {
    expect(status).toBe(200);
    expect(data.errors.filter((e) => COMPANIES.includes(e.companyId) && e.companyId !== FAILCO)).toEqual([]);
  });

  it('company A\'s report goes only to A\'s opted-in members in good standing (email matched case-insensitively, trimmed)', () => {
    expect(to(C.A)).toEqual([A2_STORED, email(U.a)].sort());
  });

  it('A\'s report never prints B\'s client name (A\'s entries on B\'s client: profitability, WIP aging)', () => {
    const html = reportFor(C.A, email(U.a));
    expect(html).toContain('R168 Client A');
    expect(html).not.toContain('SECRET CLIENT B');
  });

  it('A\'s report never prints B\'s staff name (B\'s member logged time in A)', () => {
    expect(reportFor(C.A, email(U.a))).not.toContain('SECRET STAFF B');
  });

  it('B\'s report goes to B\'s member only, and shows nothing of A\'s', () => {
    expect(to(C.B)).toEqual([email(U.b)]);
    const html = reportFor(C.B, email(U.b));
    expect(html).toContain('R168 SECRET CLIENT B');
    expect(html).not.toContain('R168 Client A');
  });

  it('skips an inactive recipient row', () => expect(to(C.A)).not.toContain(email(U.aRowInactive)));
  it('skips a recipient not opted into monthly_summary', () => expect(to(C.A)).not.toContain(email(U.aNotOptedIn)));
  it('skips an address that is no user at all', () => expect(to(C.A)).not.toContain(OUTSIDER));
  it('skips another company\'s member', () => expect(to(C.A)).not.toContain(email(U.b)));
  it('skips an inactive user', () => expect(to(C.A)).not.toContain(email(U.aInactive)));
  it('skips a user with suspended_at set', () => expect(to(C.A)).not.toContain(email(U.aSuspendedAt)));
  it('skips a user whose status is not active', () => expect(to(C.A)).not.toContain(email(U.aStatus)));
  it('counts the non-member recipients as skipped', () => expect(data.recipientsSkipped).toBeGreaterThanOrEqual(5));

  it('skips a deleted company', () => expect(to(C.DELETED)).toEqual([]));
  it('skips a company with status suspended', () => expect(to(C.SUSPENDED)).toEqual([]));
  it('skips a company with suspended_at set', () => expect(to(C.SUSPENDED_AT)).toEqual([]));

  it('a failed send is reported in errors and not counted in recipientsEmailed', () => {
    expect(to(FAILCO)).toEqual([email(U.fail)]);
    expect(data.errors.filter((e) => e.companyId === FAILCO))
      .toEqual([{ companyId: FAILCO, email: email(U.fail), error: 'R168 simulated SMTP failure' }]);
    expect(data.recipientsEmailed).toBe(mail.calls.filter((m) => m.ok).length);
  });
});
