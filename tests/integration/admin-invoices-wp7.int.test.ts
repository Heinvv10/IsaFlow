/**
 * WP7 (admin audit 2026-11-14, items 1.7, 1.8, 2.10 invoice part, and the no-silent-200 rule) through the real
 * routes, withAdmin / withPlatformAdmin and the request transaction, on the disposable schema fixture.
 *
 *  - Create accepts a blank due date and blank notes (the page used to send null; zod took only string|absent).
 *  - Create computes 15% VAT and the total itself from the subtotal; a client-sent tax or total is refused.
 *  - Send emails the invoice to the company's billing email through the app's mail sender (nodemailer is mocked:
 *    nothing leaves this process; the recipient is on the reserved .test TLD), records it in email_log, and only
 *    then marks the invoice sent. Already sent / not found / no billing email / SMTP failure answer an error and
 *    change nothing.
 *  - Mark Paid answers 409 / 404 when nothing changed, instead of a 200 and a duplicate audit row.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const mail = vi.hoisted(() => {
  const sendMail = vi.fn(async (_opts: Record<string, unknown>) => ({ messageId: 'wp7-mock-message' }));
  const createTransport = vi.fn((_cfg: unknown) => ({ sendMail }));
  return { sendMail, createTransport };
});
vi.mock('nodemailer', () => ({ default: { createTransport: mail.createTransport }, createTransport: mail.createTransport }));

import invoicesRoute from '../../pages/api/admin/billing/invoices';
import sendRoute from '../../pages/api/admin/billing/invoices/[id]/send';
import markPaidRoute from '../../pages/api/admin/billing/invoices/[id]/mark-paid';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const admin = crypto.randomUUID();
const company = crypto.randomUUID();
const noEmailCompany = crypto.randomUUID();
const BILLING = `billing-${company.slice(0, 8)}@wp7.example.test`;
type Route = (req: never, res: never) => Promise<unknown>;

async function call(route: Route, body: unknown, id?: string, query?: Record<string, string>) {
  const jar = { 'sb-access-token': await signSession(admin, crypto.randomUUID(), 'aal2') };
  const req = request(jar, body === undefined ? 'GET' : 'POST', id) as unknown as { body: unknown; query: Record<string, string> };
  if (body !== undefined) req.body = body;
  if (query) req.query = { ...req.query, ...query };
  const result = response();
  await route(req as never, result.res as never);
  return { status: result.state.statusCode, body: result.state.body as { success: boolean; data?: Record<string, unknown>; error?: { message: string } } };
}

/** A draft invoice through the create route: subtotal only, VAT and total computed by the server. */
async function created(companyId: string, subtotal: number): Promise<string> {
  const r = await call(invoicesRoute as Route, { company_id: companyId, subtotal_cents: subtotal });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return String(r.body.data?.id);
}
/** A draft written directly, so the send / mark-paid cases do not depend on the create route. */
let seq = 0;
async function draft(companyId: string, subtotal = 10000): Promise<string> {
  seq += 1;
  const number = `WP7-${company.slice(0, 6)}-${seq}`;
  const tax = Math.round(subtotal * 0.15);
  return String((await pool.query(
    `INSERT INTO admin_invoices (company_id, invoice_number, status, subtotal_cents, tax_cents, total_cents, currency)
     VALUES ($1, $2, 'draft', $3, $4, $5, 'ZAR') RETURNING id`, [companyId, number, subtotal, tax, subtotal + tax])).rows[0].id);
}
const row = async (id: string) => (await pool.query('SELECT * FROM admin_invoices WHERE id=$1', [id])).rows[0];
const audits = async (id: string, action: string) =>
  (await pool.query('SELECT COUNT(*)::int AS n FROM admin_audit_log WHERE target_id=$1 AND action=$2', [id, action])).rows[0].n as number;
const emailLog = async (companyId: string) =>
  (await pool.query('SELECT recipient_email, subject, email_type, status, sent_by FROM email_log WHERE company_id=$1 ORDER BY sent_at', [companyId])).rows;

beforeAll(async () => {
  vi.stubEnv('SMTP_HOST', 'smtp.wp7-mock.invalid');
  vi.stubEnv('SMTP_USER', 'wp7-mock');
  vi.stubEnv('SMTP_PASS', 'wp7-mock');
  await pool.query(`INSERT INTO companies (id, name, registration_number, billing_email, created_at) VALUES ($1, $2, $2, $3, NOW())`,
    [company, `WP7 Invoices ${company}`, BILLING]);
  await pool.query(`INSERT INTO companies (id, name, registration_number, created_at) VALUES ($1, $2, $2, NOW())`,
    [noEmailCompany, `WP7 No Email ${noEmailCompany}`]);
  await pool.query(`INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'super_admin',true)`, [admin, `${admin}@test.local`]);
}, 60000);

beforeEach(() => { mail.sendMail.mockClear(); mail.createTransport.mockClear(); });

afterAll(async () => {
  try {
    vi.unstubAllEnvs();
    await pool.query('DELETE FROM email_log WHERE company_id = ANY($1::uuid[])', [[company, noEmailCompany]]);
    await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id=$1', [admin]);
    await pool.query('DELETE FROM admin_invoices WHERE company_id = ANY($1::uuid[])', [[company, noEmailCompany]]);
    await pool.query('DELETE FROM users WHERE id=$1', [admin]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[company, noEmailCompany]]);
    await pool.query("DELETE FROM rate_limit_counters WHERE key='admin:127.0.0.79'");
  } finally {
    await pool.end();
  }
}, 60000);

describe('WP7 create invoice', () => {
  it('accepts a blank due date and blank notes sent as null', async () => {
    const r = await call(invoicesRoute as Route, { company_id: company, subtotal_cents: 5000, due_date: null, notes: null });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const inv = await row(String(r.body.data?.id));
    expect(inv.due_date).toBeNull();
    expect(inv.notes).toBeNull();
  }, 60000);

  it('computes 15% VAT and total = subtotal + tax from the subtotal alone', async () => {
    const inv = await row(await created(company, 100001));
    expect(inv.subtotal_cents).toBe(100001);
    expect(inv.tax_cents).toBe(15000); // 15000.15 -> 15000
    expect(inv.total_cents).toBe(115001);
    const half = await row(await created(company, 10));
    expect([half.tax_cents, half.total_cents]).toEqual([2, 12]); // 1.5 -> 2, half up
  }, 60000);

  it('refuses a client-sent tax or total instead of storing it', async () => {
    const before = (await pool.query('SELECT COUNT(*)::int AS n FROM admin_invoices WHERE company_id=$1', [company])).rows[0].n;
    for (const extra of [{ tax_cents: 0, total_cents: 1 }, { total_cents: 115000 }, { tax_cents: 15000 }]) {
      const r = await call(invoicesRoute as Route, { company_id: company, subtotal_cents: 100000, ...extra });
      expect(r.status, JSON.stringify(extra)).toBe(400);
    }
    const after = (await pool.query('SELECT COUNT(*)::int AS n FROM admin_invoices WHERE company_id=$1', [company])).rows[0].n;
    expect(after).toBe(before);
  }, 60000);

  it('caps the subtotal at the INT-safe maximum and names the field in the 400', async () => {
    const top = await row(await created(company, 1_800_000_000));
    expect([top.tax_cents, top.total_cents]).toEqual([270_000_000, 2_070_000_000]);
    const over = await call(invoicesRoute as Route, { company_id: company, subtotal_cents: 1_800_000_001 });
    expect(over.status).toBe(400);
    expect(over.body.error?.message).toMatch(/^subtotal_cents: .*at most 1800000000/);
  }, 60000);

  it('refuses an impossible due date with a clear 400, and stores blank notes as null', async () => {
    const bad = await call(invoicesRoute as Route, { company_id: company, subtotal_cents: 100, due_date: '2026-02-31' });
    expect(bad.status).toBe(400);
    expect(bad.body.error?.message).toBe('due_date: due_date is not a real date');
    const blank = await call(invoicesRoute as Route, { company_id: company, subtotal_cents: 100, notes: '   ' });
    expect(blank.status, JSON.stringify(blank.body)).toBe(200);
    expect((await row(String(blank.body.data?.id))).notes).toBeNull();
  }, 60000);

  it('lists by from_date / to_date (the names the page now sends)', async () => {
    const id = await created(company, 700);
    await pool.query("UPDATE admin_invoices SET created_at = '2024-03-15T10:00:00Z' WHERE id=$1", [id]);
    const hit = await call(invoicesRoute as Route, undefined, undefined, { company_id: company, from_date: '2024-03-01', to_date: '2024-03-31' });
    expect(hit.status).toBe(200);
    expect((hit.body.data?.items as Array<{ id: string }>).map((i) => i.id)).toEqual([id]);
    const miss = await call(invoicesRoute as Route, undefined, undefined, { company_id: company, from_date: '2024-04-01', to_date: '2024-04-30' });
    expect(miss.body.data?.total).toBe(0);
  }, 60000);
});

describe('WP7 send invoice', () => {
  it('emails the billing address through the mail sender, logs it, then marks the invoice sent', async () => {
    const id = await draft(company, 20000);
    const inv = await row(id);
    const r = await call(sendRoute as Route, { confirmed_to: BILLING }, id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ sent: true, recipient: BILLING });
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    const sent = mail.sendMail.mock.calls[0]![0];
    expect(sent.to).toBe(BILLING); // one address as a string: never a list
    expect(Object.keys(sent).filter((k) => ['cc', 'bcc'].includes(k))).toEqual([]);
    expect(String(sent.subject)).toContain(inv.invoice_number);
    expect(String(sent.html)).toContain(inv.invoice_number);
    expect(String(sent.html)).toContain('230.00'); // total R 230.00 (20000 + 15% VAT)
    expect((await row(id)).status).toBe('sent');
    const logged = (await emailLog(company)).filter((e) => String(e.subject).includes(inv.invoice_number));
    expect(logged).toEqual([{ recipient_email: BILLING, subject: sent.subject, email_type: 'invoice', status: 'sent', sent_by: admin }]);
    expect(await audits(id, 'invoice.send')).toBe(1);
  }, 60000);

  it('answers 409 for an invoice already sent: no second email, no second audit row', async () => {
    const id = await draft(company);
    expect((await call(sendRoute as Route, { confirmed_to: BILLING }, id)).status).toBe(200);
    mail.sendMail.mockClear();
    const again = await call(sendRoute as Route, { confirmed_to: BILLING }, id);
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(mail.sendMail).not.toHaveBeenCalled();
    expect(await audits(id, 'invoice.send')).toBe(1);
  }, 60000);

  it('answers 404 for an invoice that does not exist, and writes no audit row', async () => {
    const ghost = crypto.randomUUID();
    const r = await call(sendRoute as Route, { confirmed_to: BILLING }, ghost);
    expect(r.status, JSON.stringify(r.body)).toBe(404);
    expect(mail.sendMail).not.toHaveBeenCalled();
    expect(await audits(ghost, 'invoice.send')).toBe(0);
  }, 60000);

  it('refuses a company with no billing email: still draft, nothing sent', async () => {
    const id = await draft(noEmailCompany);
    const r = await call(sendRoute as Route, { confirmed_to: BILLING }, id);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.error?.message).toMatch(/billing email/i);
    expect(mail.sendMail).not.toHaveBeenCalled();
    expect((await row(id)).status).toBe('draft');
  }, 60000);

  it('an SMTP failure answers 424, leaves the invoice draft, and logs the failed attempt', async () => {
    const id = await draft(company);
    const inv = await row(id);
    mail.sendMail.mockRejectedValueOnce(Object.assign(new Error('mock SMTP said no'), { code: 'EENVELOPE' }));
    const r = await call(sendRoute as Route, { confirmed_to: BILLING }, id);
    expect(r.status, JSON.stringify(r.body)).toBe(424);
    expect((await row(id)).status).toBe('draft');
    const logged = (await emailLog(company)).filter((e) => String(e.subject).includes(inv.invoice_number));
    expect(logged.map((e) => e.status)).toEqual(['failed']);
    expect(await audits(id, 'invoice.send_failed')).toBe(1);
  }, 60000);
});

describe('WP7 mark paid', () => {
  it('a draft answers 409 and stays draft', async () => {
    const id = await draft(company);
    const r = await call(markPaidRoute as Route, { payment_method: 'manual' }, id);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect((await row(id)).status).toBe('draft');
    expect(await audits(id, 'invoice.mark_paid')).toBe(0);
  }, 60000);

  it('a sent invoice is paid once; the second answers 409 with no second audit row', async () => {
    const id = await draft(company);
    expect((await call(sendRoute as Route, { confirmed_to: BILLING }, id)).status).toBe(200);
    const first = await call(markPaidRoute as Route, { payment_method: 'manual' }, id);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect((await row(id)).status).toBe('paid');
    const second = await call(markPaidRoute as Route, { payment_method: 'manual' }, id);
    expect(second.status).toBe(409);
    expect(await audits(id, 'invoice.mark_paid')).toBe(1);
  }, 60000);

  it('an invoice that does not exist answers 404', async () => {
    const r = await call(markPaidRoute as Route, { payment_method: 'manual' }, crypto.randomUUID());
    expect(r.status).toBe(404);
  }, 60000);
});
