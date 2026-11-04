/**
 * Budgets P5-4 review (PR #1115): a digest delivery failure is not a finished run. Real PostgreSQL as the
 * cron's role (isaflow_service), the SMTP transport stubbed. Crossings commit before the email, so a
 * recipient whose send failed would lose the digest for good unless the next daily run retries it:
 * - the failed recipient is retried on the next run, with the alert it missed, even though nothing new fired;
 * - the recipient whose send succeeded is NOT sent it again;
 * - the company run reports ok:false (so the cron answers 500) while a send fails, ok:true once retried;
 * - a run after that sends nothing (the debt is cleared by the successful send).
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
const smtp = vi.hoisted(() => ({ sendMail: vi.fn(async (_o: { to: string; subject: string; html: string }) => ({ messageId: 'stub' })) }));
vi.mock('nodemailer', () => {
  const createTransport = vi.fn(() => ({ sendMail: smtp.sendMail }));
  return { default: { createTransport }, createTransport };
});

import { runBudgetAlertsFor } from '@/modules/accounting/services/budgets/budgetAlertCron';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const cronPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
cronPool.on('connect', (c) => { void c.query('SET ROLE isaflow_service'); });
cron.pool = cronPool;
const SMTP_ENV = { SMTP_HOST: 'smtp.invalid', SMTP_USER: 'stub', SMTP_PASS: 'stub', SMTP_FROM: 'alerts@test.local' } as const;
const envBefore = Object.fromEntries(Object.keys(SMTP_ENV).map((k) => [k, process.env[k]]));
const mails = () => smtp.sendMail.mock.calls.map(([o]) => o);
let f: AlertFixture;

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

beforeAll(async () => {
  f = await seedAlertFixture(pool);
  await pool.query(`INSERT INTO budget_control_settings (company_id, alert_email_enabled, updated_by) VALUES ($1, true, $2)`, [f.a, f.ownerA]);
}, 120_000);
afterAll(async () => {
  try { await dropAlertFixture(pool, f); } finally { await cronPool.end(); await pool.end(); }
  for (const [k, v] of Object.entries(envBefore)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
beforeEach(() => {
  smtp.sendMail.mockClear();
  process.env.BUDGET_ALERT_EMAIL_ENABLED = '1';
  Object.assign(process.env, SMTP_ENV);
});

describe('the digest retries only the recipients whose send failed', () => {
  it('failed recipient retried next run with the missed alert; the delivered one not resent; run not ok until retried', async () => {
    const owner = `${f.ownerA}@test.local`;
    const admin = `${f.adminA}@test.local`;
    await committed((c) => journal(c, f.a, '2026-04-10', f.ownerA, [[f.acc.opex, 1050, 0], [f.acc.bank, 0, 1050]]));

    // Run 1: the owner's mailbox refuses; the admin's send goes through.
    smtp.sendMail.mockImplementation(async (o: { to: string }) => {
      if (o.to === owner) throw new Error('450 mailbox busy');
      return { messageId: 'stub' };
    });
    const first = await runBudgetAlertsFor([f.a], AS_OF);
    expect(first.perCompany[0]).toMatchObject({ ok: false, fired: 2, digest: { sent: 1, failed: 1 } });
    expect(first.failed).toBe(1);
    expect(mails().map((m) => m.to).sort()).toEqual([admin, owner].sort());

    // Run 2 (no new crossing, mail server back): only the owner is sent, with the alert they missed.
    smtp.sendMail.mockClear();
    smtp.sendMail.mockImplementation(async () => ({ messageId: 'stub' }));
    const second = await runBudgetAlertsFor([f.a], AS_OF);
    expect(second.perCompany[0]).toMatchObject({ ok: true, fired: 0, digest: { skipped: null, sent: 1, failed: 0 } });
    expect(second.failed).toBe(0);
    expect(mails().map((m) => m.to)).toEqual([owner]);
    expect(mails()[0]!.html).toContain('P5A-6000 Office costs');

    // Run 3: the debt is cleared; nothing goes to anyone.
    smtp.sendMail.mockClear();
    const third = await runBudgetAlertsFor([f.a], AS_OF);
    expect(third.perCompany[0]).toMatchObject({ ok: true, digest: { skipped: 'nothing_fired', sent: 0 } });
    expect(mails()).toEqual([]);
  }, 60_000);
});
