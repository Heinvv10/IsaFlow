/**
 * WP7 review of #1368, M1/M2: the admin invoice Send is claim -> email -> finalise, each committed on its own
 * (migration 991), and nothing of the request is held open across the SMTP call. Through the real route,
 * withAdmin / withPlatformAdmin, on the disposable schema fixture; nodemailer is mocked (nothing leaves this
 * process) and every recipient is on the reserved .test TLD.
 *
 *  - a second Send while the first is still talking to the mail server is refused AT ONCE (409), the row is not
 *    locked meanwhile, the claim and its audit row are already committed, and exactly one email goes out;
 *  - a finalise that fails after the email left keeps the claim, the audit row and the email_log row, answers a
 *    5xx, and a retry is a 409 that sends nothing;
 *  - SMTP is bounded (connection / greeting / socket timeouts), and a timeout - which proves nothing about
 *    whether the message left - keeps the claim: no automatic second email;
 *  - the route never answers sent:true when the status did not change;
 *  - Mark Paid answers a 5xx, not a 400, on an unexpected database error.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const mail = vi.hoisted(() => {
  const sendMail = vi.fn(async (_opts: Record<string, unknown>) => ({ messageId: 'wp7-claim-mock' }));
  const close = vi.fn();
  const createTransport = vi.fn((_cfg: Record<string, unknown>) => ({ sendMail, close }));
  return { sendMail, close, createTransport };
});
vi.mock('nodemailer', () => ({ default: { createTransport: mail.createTransport }, createTransport: mail.createTransport }));
// The real 45 s hard deadline, shortened for the suite (the mechanism is the same; see invoiceSendTiming.ts).
vi.mock('@/modules/admin/services/invoiceSendTiming', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/admin/services/invoiceSendTiming')>()),
  SEND_DEADLINE_MS: 1_500,
}));

import sendRoute from '../../pages/api/admin/billing/invoices/[id]/send';
import markPaidRoute from '../../pages/api/admin/billing/invoices/[id]/mark-paid';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const admin = crypto.randomUUID();
const company = crypto.randomUUID();
const BILLING = `claim-${company.slice(0, 8)}@wp7.example.test`;
const TRIGGER_FN = `wp7_claim_refuse_${company.replace(/-/g, '').slice(0, 12)}`;
type Result = { status: number; body: { success: boolean; data?: Record<string, unknown>; error?: { message: string } } };

async function call(route: (req: never, res: never) => Promise<unknown>, body: unknown, id: string): Promise<Result> {
  const jar = { 'sb-access-token': await signSession(admin, crypto.randomUUID(), 'aal2') };
  const req = request(jar, 'POST', id) as unknown as { body: unknown };
  req.body = body;
  const result = response();
  await route(req as never, result.res as never);
  return { status: result.state.statusCode, body: result.state.body as Result['body'] };
}
const send = (id: string) => call(sendRoute as never, { confirmed_to: BILLING }, id);
let seq = 0;
async function draft(): Promise<string> {
  seq += 1;
  return String((await pool.query(
    `INSERT INTO admin_invoices (company_id, invoice_number, status, subtotal_cents, tax_cents, total_cents, currency)
     VALUES ($1, $2, 'draft', 10000, 1500, 11500, 'ZAR') RETURNING id`, [company, `WP7C-${company.slice(0, 5)}-${seq}`])).rows[0].id);
}
const row = async (id: string) => (await pool.query('SELECT * FROM admin_invoices WHERE id=$1', [id])).rows[0];
const audits = async (id: string, action: string) =>
  (await pool.query('SELECT COUNT(*)::int AS n FROM admin_audit_log WHERE target_id=$1 AND action=$2', [id, action])).rows[0].n as number;
const sentLog = async (invoiceNumber: string) =>
  (await pool.query("SELECT status FROM email_log WHERE company_id=$1 AND subject LIKE $2", [company, `%${invoiceNumber}%`])).rows.map((r) => r.status);
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}
async function until(check: () => boolean, ms = 10000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
/** A trigger that refuses this one invoice's UPDATE to `status` (the test's stand-in for a failing finalise). */
async function refuseStatus(id: string, status: string) {
  await pool.query(`CREATE OR REPLACE FUNCTION ${TRIGGER_FN}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.id = '${id}'::uuid AND NEW.status = '${status}' THEN RAISE EXCEPTION 'wp7 test: refused'; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER ${TRIGGER_FN} BEFORE UPDATE ON admin_invoices FOR EACH ROW EXECUTE FUNCTION ${TRIGGER_FN}()`);
}
async function dropRefusal() {
  await pool.query(`DROP TRIGGER IF EXISTS ${TRIGGER_FN} ON admin_invoices`);
  await pool.query(`DROP FUNCTION IF EXISTS ${TRIGGER_FN}()`);
}

beforeAll(async () => {
  vi.stubEnv('SMTP_HOST', 'smtp.wp7-mock.invalid');
  vi.stubEnv('SMTP_USER', 'wp7-mock');
  vi.stubEnv('SMTP_PASS', 'wp7-mock');
  await pool.query(`INSERT INTO companies (id, name, registration_number, billing_email, created_at) VALUES ($1, $2, $2, $3, NOW())`,
    [company, `WP7 Claim ${company}`, BILLING]);
  await pool.query(`INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'super_admin',true)`, [admin, `${admin}@test.local`]);
}, 60000);

beforeEach(() => { mail.sendMail.mockClear(); mail.createTransport.mockClear(); mail.close.mockClear(); });

afterAll(async () => {
  try {
    vi.unstubAllEnvs();
    await dropRefusal();
    await pool.query('DELETE FROM email_log WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id=$1', [admin]);
    await pool.query('DELETE FROM admin_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [admin]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query("DELETE FROM rate_limit_counters WHERE key='admin:127.0.0.79'");
  } finally {
    await pool.end();
  }
}, 60000);

describe('WP7 send: claim, then email, then finalise', () => {
  it('a concurrent Send is refused at once while the first is sending; no row lock; exactly one email', async () => {
    const id = await draft();
    const smtp = gate();
    mail.sendMail.mockImplementationOnce(async () => { await smtp.promise; return { messageId: 'first' }; });
    const first = send(id);
    try {
      await until(() => mail.sendMail.mock.calls.length === 1);
      // While the mail server "talks": the claim and its audit row are committed, and nothing locks the row.
      expect((await row(id)).send_claimed_at).not.toBeNull();
      expect(await audits(id, 'invoice.send_started')).toBe(1);
      const probe = await pool.connect();
      try {
        await probe.query('BEGIN');
        await probe.query('SELECT id FROM admin_invoices WHERE id=$1 FOR UPDATE NOWAIT', [id]);
      } finally {
        await probe.query('ROLLBACK');
        probe.release();
      }
      const second = await Promise.race([send(id), new Promise<'blocked'>((r) => setTimeout(() => r('blocked'), 4000))]);
      expect(second).not.toBe('blocked');
      expect((second as Result).status).toBe(409);
      expect((second as Result).body.error?.message).toMatch(/in progress or its outcome is unknown/);
    } finally {
      smtp.open();
    }
    expect((await first).status).toBe(200);
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    const after = await row(id);
    expect([after.status, after.send_claimed_at]).toEqual(['sent', null]);
  }, 60000);

  it('a finalise that fails after the email left keeps claim, audit and email_log; a retry is 409 and sends nothing', async () => {
    const id = await draft();
    const number = (await row(id)).invoice_number as string;
    await refuseStatus(id, 'sent');
    let r: Result;
    try {
      r = await send(id);
    } finally {
      await dropRefusal();
    }
    expect(r.status, JSON.stringify(r.body)).toBe(500);
    expect(r.body.error?.message).toMatch(/was sent/);
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    const held = await row(id);
    expect(held.status).toBe('draft');
    expect(held.send_claimed_at).not.toBeNull();
    expect(await audits(id, 'invoice.send_started')).toBe(1);
    expect(await sentLog(number)).toEqual(['sent']);

    const retry = await send(id);
    expect(retry.status, JSON.stringify(retry.body)).toBe(409);
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
  }, 60000);

  it('SMTP is bounded, and a timeout keeps the claim: the retry is a 409, never a second email', async () => {
    const id = await draft();
    mail.sendMail.mockRejectedValueOnce(Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' }));
    const r = await send(id);
    const cfg = mail.createTransport.mock.calls[0]![0];
    for (const key of ['connectionTimeout', 'greetingTimeout', 'socketTimeout']) {
      expect(cfg[key], key).toBeGreaterThan(0);
      expect(cfg[key], key).toBeLessThanOrEqual(20_000);
    }
    expect(r.status, JSON.stringify(r.body)).toBe(424);
    expect(r.body.error?.message).toMatch(/did not confirm/);
    expect((await row(id)).send_claimed_at).not.toBeNull();
    expect(await audits(id, 'invoice.send_unknown')).toBe(1);
    const retry = await send(id);
    expect(retry.status).toBe(409);
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
  }, 60000);

  it('a mail server that never finishes is cut at the hard deadline: transport closed, outcome unknown, claim kept', async () => {
    const id = await draft();
    mail.sendMail.mockImplementationOnce(() => new Promise(() => { /* the server keeps the conversation going */ }));
    const started = Date.now();
    const r = await Promise.race([send(id), new Promise<'hung'>((res) => setTimeout(() => res('hung'), 10_000))]);
    expect(r, 'no hard deadline: the Send waited on the mail server').not.toBe('hung');
    const result = r as Result;
    expect(result.status, JSON.stringify(result.body)).toBe(424);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.body.error?.message).toMatch(/did not confirm/);
    expect(mail.close).toHaveBeenCalled();
    expect((await row(id)).send_claimed_at).not.toBeNull();
    expect(await audits(id, 'invoice.send_unknown')).toBe(1);
  }, 60000);

  it('never answers sent:true when the status did not change', async () => {
    const id = await draft();
    mail.sendMail.mockImplementationOnce(async () => {
      // While the email is out, the invoice stops being a claimed draft (bounded: a lock wait is the old defect).
      const c = await pool.connect();
      try {
        await c.query("SET lock_timeout = '1s'");
        await c.query("UPDATE admin_invoices SET status='cancelled', send_claimed_at=NULL WHERE id=$1", [id]);
      } catch (err) {
        expect.soft(String(err), 'the row was locked across the SMTP call').toBe('');
      } finally {
        c.release();
      }
      return { messageId: 'x' };
    });
    const r = await send(id);
    expect(r.status, JSON.stringify(r.body)).toBe(500);
    expect(r.body.data?.sent).toBeUndefined();
  }, 60000);
});

describe('WP7 mark paid', () => {
  it('an unexpected database error is a 5xx, not a 400', async () => {
    const id = await draft();
    await pool.query("UPDATE admin_invoices SET status='sent' WHERE id=$1", [id]);
    await refuseStatus(id, 'paid');
    let r: Result;
    try {
      r = await call(markPaidRoute as never, { payment_method: 'manual' }, id);
    } finally {
      await dropRefusal();
    }
    expect(r.status, JSON.stringify(r.body)).toBe(500);
    expect((await row(id)).status).toBe('sent');
  }, 60000);
});
