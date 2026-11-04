/**
 * Budgets P5-4 (spec §3d, §6 T9, §7): the daily run behind POST /api/cron/budget-alerts, on real
 * PostgreSQL AS THE CRON'S ROLE: every connection the run opens is `isaflow_service` (the service
 * pool's production login: app_service, no claims, 915's mirrors; census finding 9). Data committed.
 * - run ×2: one alert and one notification per crossing per owner/admin, nothing for the manager,
 *   "last evaluated" recorded per company;
 * - one company failing (its evaluation lock held past the wait) does not stop the next, and keeps
 *   its previous "last evaluated";
 * - the email digest is NOT sent by default (no settings row), nor with only the company flag, nor
 *   with only the server switch; with both it goes to each owner/admin, escaped. `sendEmail` is a
 *   mock: no SMTP is ever reached.
 * - which companies the run takes (active, with a primary version or an open alert).
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { AS_OF, dropAlertFixture, journal, seedAlertFixture, type AlertFixture } from './helpers/budgetAlertsFixture';

const cron = vi.hoisted(() => ({ pool: null as unknown }));
vi.mock('@/lib/neon', async (importOriginal) => {
  const m = await importOriginal<typeof import('@/lib/neon')>();
  return { ...m, getPool: () => cron.pool as ReturnType<typeof m.getPool> };
});
// The SMTP transport is stubbed (no mail server is ever reached); sendEmail and its email_log write are real.
const smtp = vi.hoisted(() => ({ sendMail: null as unknown as ReturnType<typeof import('vitest').vi.fn> }));
vi.mock('nodemailer', async () => {
  const { vi: v } = await import('vitest');
  smtp.sendMail = v.fn(async () => ({ messageId: 'stub' }));
  const createTransport = v.fn(() => ({ sendMail: smtp.sendMail }));
  return { default: { createTransport }, createTransport };
});

import { loadAlertCompanies, runBudgetAlertsFor } from '@/modules/accounting/services/budgets/budgetAlertCron';
import { LAST_EVALUATED_KEYS } from '@/modules/accounting/services/budgets/budgetAlertRuns';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const cronPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
cronPool.on('connect', (c) => { void c.query('SET ROLE isaflow_service'); });
let acquired = 0;
cronPool.on('acquire', () => { acquired += 1; });
cron.pool = cronPool;
const SMTP_ENV = { SMTP_HOST: 'smtp.invalid', SMTP_USER: 'stub', SMTP_PASS: 'stub', SMTP_FROM: 'alerts@test.local' } as const;
const envBefore = Object.fromEntries(Object.keys(SMTP_ENV).map((k) => [k, process.env[k]]));
const sent = () => (smtp.sendMail?.mock.calls ?? []).map(([o]) => o as { to: string; subject: string; html: string });
let f: AlertFixture;
const noBudget = crypto.randomUUID();

beforeAll(async () => {
  f = await seedAlertFixture(pool);
  await pool.query(`INSERT INTO companies (id, name) VALUES ($1, 'P5A no budget')`, [noBudget]);
}, 120_000);
afterAll(async () => {
  try {
    await dropAlertFixture(pool, f);
    await pool.query('DELETE FROM companies WHERE id = $1', [noBudget]);
  } finally {
    await cronPool.end();
    await pool.end();
  }
});
beforeEach(() => {
  smtp.sendMail?.mockClear();
  delete process.env.BUDGET_ALERT_EMAIL_ENABLED;
  Object.assign(process.env, SMTP_ENV);
});
afterAll(() => {
  for (const [k, v] of Object.entries(envBefore)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

/** Commits `fn`'s writes as the fixture's superuser. */
async function committed(fn: (c: PoolClient) => Promise<unknown>): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await fn(c);
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally { c.release(); }
}
const spend = (co: string, acct: string, bank: string, user: string, date: string, amount: number) =>
  committed((c) => journal(c, co, date, user, [[acct, amount, 0], [bank, 0, amount]]));
const count = async (text: string, params: unknown[]) => Number((await pool.query(text, params)).rows[0].n);
const lastEvaluated = async (co: string) => {
  const r = await pool.query('SELECT value FROM accounting_settings WHERE company_id = $1 AND key = $2', [co, LAST_EVALUATED_KEYS.daily]);
  return r.rows[0] ? JSON.parse(String(r.rows[0].value)) as { at: string; source: string; fired: number } : null;
};

describe('the daily run, as isaflow_service', () => {
  it('runs on the cron\'s login role', async () => {
    const r = await cronPool.query('SELECT current_user AS u');
    expect(r.rows[0].u).toBe('isaflow_service');
  });

  it('run ×2: one alert and one notification per crossing per owner/admin; last evaluated recorded; no email by default', async () => {
    await spend(f.a, f.acc.opex, f.acc.bank, f.ownerA, '2026-04-10', 1050);
    await spend(f.b, f.acc.bOpex, f.acc.bBank, f.ownerB, '2026-04-10', 90);
    // The server switch on: the company flag (no settings row = OFF) alone must keep the email off.
    process.env.BUDGET_ALERT_EMAIL_ENABLED = '1';
    const before = acquired;
    const first = await runBudgetAlertsFor([f.a, f.b], AS_OF);
    // Every company's transaction came from the cron pool (isaflow_service), none from the superuser's.
    expect(acquired - before).toBe(2);
    expect(first.perCompany.map((r) => [r.companyId, r.ok, r.fired, r.digest?.skipped])).toEqual([
      [f.a, true, 2, 'company_off'], [f.b, true, 1, 'company_off'],
    ]);
    const second = await runBudgetAlertsFor([f.a, f.b], AS_OF);
    expect(second.perCompany.map((r) => [r.ok, r.fired, r.resolved, r.digest?.skipped])).toEqual([[true, 0, 0, 'nothing_fired'], [true, 0, 0, 'nothing_fired']]);
    expect(sent()).toEqual([]);
    expect(await count('SELECT COUNT(*)::INT n FROM budget_alerts WHERE company_id = $1', [f.a])).toBe(2);
    // The daily run keeps its own record; Evaluate now's stays empty.
    expect(await count(`SELECT COUNT(*)::INT n FROM accounting_settings WHERE company_id = $1 AND key = $2`, [f.a, LAST_EVALUATED_KEYS.manual])).toBe(0);
    expect(await count('SELECT COUNT(*)::INT n FROM budget_alerts WHERE company_id = $1', [f.b])).toBe(1);
    const per = async (co: string, u: string) => count(`SELECT COUNT(*)::INT n FROM user_notifications WHERE company_id = $1 AND user_id = $2`, [co, u]);
    expect([await per(f.a, f.ownerA), await per(f.a, f.adminA), await per(f.a, f.managerA), await per(f.b, f.ownerB), await per(f.a, f.ownerB)])
      .toEqual([1, 1, 0, 1, 0]); // A crossed 80 and 100 in one run: one notification (the 100)
    for (const co of [f.a, f.b]) expect(await lastEvaluated(co)).toMatchObject({ source: 'daily', fired: 0 });
  });

  it('one company failing does not stop the next; the failed one keeps its previous "last evaluated"', async () => {
    await spend(f.b, f.acc.bOpex, f.acc.bBank, f.ownerB, '2026-04-11', 20); // B: 110 of 100 → 100% crosses
    const beforeA = await lastEvaluated(f.a);
    const beforeB = await lastEvaluated(f.b);
    const holder = await pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock(hashtextextended($1, 954))', [`budget_alerts:${f.a}`]);
      const out = await runBudgetAlertsFor([f.a, f.b], AS_OF);
      expect(out.perCompany.map((r) => [r.companyId, r.ok, r.fired])).toEqual([[f.a, false, 0], [f.b, true, 1]]);
      expect(out.perCompany[0]!.error).toBe('evaluation failed; see logs');
      expect(out.failed).toBe(1);
    } finally {
      await holder.query('SELECT pg_advisory_unlock(hashtextextended($1, 954))', [`budget_alerts:${f.a}`]);
      holder.release();
    }
    expect(await lastEvaluated(f.a)).toEqual(beforeA);
    expect((await lastEvaluated(f.b))!.at > beforeB!.at).toBe(true);
    expect(await count(`SELECT COUNT(*)::INT n FROM budget_alerts WHERE company_id = $1 AND threshold = 100`, [f.b])).toBe(1);
  }, 30_000);

  it('the email digest needs BOTH the company flag and BUDGET_ALERT_EMAIL_ENABLED=1; with both, each owner/admin gets one, escaped', async () => {
    await committed((c) => c.query(`INSERT INTO budget_control_settings (company_id, alert_email_enabled, updated_by) VALUES ($1, true, $2)`, [f.a, f.ownerA]));
    // Flag on, server switch unset: nothing leaves.
    await spend(f.a, f.acc.opex, f.acc.bank, f.ownerA, '2026-03-10', 850); // March 85%: crosses 80
    const flagOnly = await runBudgetAlertsFor([f.a], AS_OF);
    expect(flagOnly.perCompany[0]).toMatchObject({ ok: true, fired: 1, digest: { skipped: 'server_off', sent: 0 } });
    expect(sent()).toEqual([]);

    process.env.BUDGET_ALERT_EMAIL_ENABLED = '1';
    await spend(f.a, f.acc.opex, f.acc.bank, f.ownerA, '2026-03-12', 200); // March 105%: crosses 100
    const taken = acquired;
    const both = await runBudgetAlertsFor([f.a], AS_OF);
    // The evaluation's transaction, then one short company-context transaction per email_log row
    // (2 recipients), all on the cron's role; the SMTP sends themselves hold no connection.
    expect(acquired - taken).toBe(3);
    expect(both.perCompany[0]).toMatchObject({ ok: true, fired: 1, digest: { skipped: null, sent: 2, failed: 0 } });
    expect(sent()).toHaveLength(2);
    const to = sent().map((o) => o.to).sort();
    expect(to).toEqual([`${f.ownerA}@test.local`, `${f.adminA}@test.local`].sort());
    // sendEmail's own email_log write, as the cron's role after the evaluation committed: one 'sent' row per recipient.
    const logged = await pool.query(`SELECT recipient_email, status, email_type FROM email_log WHERE company_id = $1 ORDER BY recipient_email`, [f.a]);
    expect(logged.rows).toEqual(to.map((t) => ({ recipient_email: t, status: 'sent', email_type: 'other' })));
    const mail = sent()[0]!;
    expect(mail.subject).toBe('Budget alerts — P5A <Alerts> & Co: 1 new overspend alert');
    expect(mail.html).toContain('P5A &lt;Alerts&gt; &amp; Co');
    expect(mail.html).not.toContain('<Alerts>');
    expect(mail.html).toContain('P5A-6000 Office costs');
    expect(mail.html).toContain('/accounting/reports/budget-vs-actual?period=month&amp;month=2026-03');
  });

  it('the digest sends outside any transaction; one failed send counts 1 failed, and each email has its own email_log row', async () => {
    process.env.BUDGET_ALERT_EMAIL_ENABLED = '1';
    const held: number[] = [];
    let call = 0;
    smtp.sendMail.mockImplementation(async () => {
      held.push(cronPool.totalCount - cronPool.idleCount);
      call += 1;
      if (call === 1) throw new Error('550 mailbox unavailable');
      return { messageId: 'stub' };
    });
    try {
      await spend(f.a, f.acc.opex, f.acc.bank, f.ownerA, '2026-04-12', 200); // April opex 125%: crosses 120
      const out = await runBudgetAlertsFor([f.a], AS_OF);
      expect(out.perCompany[0]).toMatchObject({ ok: true, fired: 1, digest: { skipped: null, sent: 1, failed: 1 } });
      expect(held).toEqual([0, 0]); // no pooled connection checked out while SMTP runs
      const logged = await pool.query(`SELECT status, error_message FROM email_log WHERE company_id = $1 AND subject LIKE '%1 new overspend alert' ORDER BY sent_at DESC LIMIT 2`, [f.a]);
      expect(logged.rows.map((r) => r.status).sort()).toEqual(['failed', 'sent']);
      expect(logged.rows.find((r) => r.status === 'failed')!.error_message).toBe('550 mailbox unavailable');
    } finally {
      smtp.sendMail.mockImplementation(async () => ({ messageId: 'stub' }));
    }
  });

  it('a deactivated admin is not notified by the daily run', async () => {
    await pool.query('UPDATE users SET is_active = false WHERE id = $1', [f.adminA]);
    try {
      await committed((c) => journal(c, f.a, '2026-03-20', f.ownerA, [[f.acc.rent, 450, 0, { cc1: f.cc.FT }], [f.acc.bank, 0, 450]])); // rent FT March 90%: crosses 80
      const before = await count(`SELECT COUNT(*)::INT n FROM user_notifications WHERE company_id = $1 AND user_id = $2`, [f.a, f.adminA]);
      const out = await runBudgetAlertsFor([f.a], AS_OF);
      expect(out.perCompany[0]).toMatchObject({ ok: true, fired: 1 });
      expect(await count(`SELECT COUNT(*)::INT n FROM user_notifications WHERE company_id = $1 AND user_id = $2`, [f.a, f.adminA])).toBe(before);
      expect(await count(`SELECT COUNT(*)::INT n FROM user_notifications WHERE company_id = $1 AND user_id = $2 AND title LIKE 'P5A-6100%'`, [f.a, f.ownerA])).toBe(1);
    } finally {
      await pool.query('UPDATE users SET is_active = true WHERE id = $1', [f.adminA]);
    }
  });

  it('a suspended owner gets no bell alert from the daily run; the admin does', async () => {
    await pool.query(`UPDATE users SET status = 'suspended', suspended_at = now() WHERE id = $1`, [f.ownerA]);
    try {
      await committed((c) => journal(c, f.a, '2026-03-21', f.ownerA, [[f.acc.rent, 100, 0, { cc1: f.cc.FT }], [f.acc.bank, 0, 100]])); // rent FT March 110%: crosses 100
      const per = async (u: string) => count(`SELECT COUNT(*)::INT n FROM user_notifications WHERE company_id = $1 AND user_id = $2`, [f.a, u]);
      const [owner, admin] = [await per(f.ownerA), await per(f.adminA)];
      const out = await runBudgetAlertsFor([f.a], AS_OF);
      expect(out.perCompany[0]).toMatchObject({ ok: true, fired: 1 });
      expect([await per(f.ownerA), await per(f.adminA)]).toEqual([owner, admin + 1]);
    } finally {
      await pool.query(`UPDATE users SET status = 'active', suspended_at = NULL WHERE id = $1`, [f.ownerA]);
    }
  });

  it('takes active companies with a primary version (or an open alert); not a suspended one, not one with no budget', async () => {
    expect((await loadAlertCompanies()).filter((c) => [f.a, f.b, noBudget].includes(c)).sort()).toEqual([f.a, f.b].sort());
    await pool.query(`UPDATE companies SET status = 'suspended' WHERE id = $1`, [f.b]);
    try {
      expect((await loadAlertCompanies()).includes(f.b)).toBe(false);
    } finally {
      await pool.query(`UPDATE companies SET status = 'active' WHERE id = $1`, [f.b]);
    }
  });
});
