// tests/integration/r086-send-status-guard-route.int.test.ts
//
// R-086 review round 4 (adversarial MEDIUM). Migration validation counts every
// 'sent' invoice as AR. The send action used to accept any status but
// 'cancelled', so a draft (never posted) became 'sent' — AR with no journal —
// and a paid invoice was demoted back to open. Driven through the real handler
// (withAuth, CSRF, write access) and asserted by the row's status afterwards.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import invoiceDetail from '../../pages/api/accounting/customer-invoices-detail';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;

const CO = randomUUID();
const USER = randomUUID();
const CUST = randomUUID();
const INV: Record<string, string> = {
  draft: randomUUID(), approved: randomUUID(), sent: randomUUID(), paid: randomUUID(), cancelled: randomUUID(),
};

describeIfDb('R-086 r4 — only an approved invoice can be marked sent', () => {
  let pool: Pool;
  let token = '';

  async function send(id: string) {
    const req = request({ 'sb-access-token': token, active_company_id: CO }, 'POST') as never as
      { body: unknown; query: Record<string, string>; url: string };
    req.body = { id, action: 'send' };
    req.query = {};
    req.url = '/api/accounting/customer-invoices-detail';
    const out = response();
    await invoiceDetail(req as never, out.res as never);
    return out.state;
  }
  const statusOf = async (id: string): Promise<string> =>
    String((await pool.query('SELECT status FROM customer_invoices WHERE id = $1', [id])).rows[0].status);

  beforeAll(async () => {
    assertDisposable();
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)', [CO, 'R086 send guard']);
    await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)",
      [USER, `r086send-${USER}@isaflow.test`]);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')", [CO, USER]);
    await pool.query('INSERT INTO customers (id, company_id, name) VALUES ($1, $2, $3)', [CUST, CO, 'R086 Customer']);
    for (const [status, id] of Object.entries(INV)) {
      await pool.query(
        `INSERT INTO customer_invoices (id, company_id, invoice_number, customer_id, client_id, invoice_date,
           subtotal, tax_amount, total_amount, amount_paid, status, created_by)
         VALUES ($1, $2, $3, $4, $4, CURRENT_DATE, 100, 15, 115, $5, $6, $7)`,
        [id, CO, `R086-SEND-${status}`, CUST, status === 'paid' ? 115 : 0, status, USER]);
    }
    token = await new SignJWT({ sub: USER, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      // A successful send seals a PDF snapshot into captured_documents, which
      // customer_invoices.source_document_id then points at.
      await pool.query('UPDATE customer_invoices SET source_document_id = NULL WHERE company_id = $1', [CO]);
      await pool.query('DELETE FROM captured_documents WHERE company_id = $1', [CO]);
      await pool.query('DELETE FROM customer_invoices WHERE company_id = $1', [CO]);
      await pool.query('DELETE FROM customers WHERE company_id = $1', [CO]);
      await pool.query('DELETE FROM company_users WHERE company_id = $1', [CO]);
      await pool.query('DELETE FROM companies WHERE id = $1', [CO]);
      await pool.query('DELETE FROM users WHERE id = $1', [USER]);
    } finally { await pool.end(); }
  });

  it.each(['draft', 'paid', 'cancelled'])('refuses to send a %s invoice and leaves its status alone', async (status) => {
    const out = await send(INV[status]!);
    expect(out.statusCode).toBe(400);
    expect(await statusOf(INV[status]!)).toBe(status);
  });

  it.each(['approved', 'sent'])('sends an %s invoice', async (status) => {
    const out = await send(INV[status]!);
    expect(out.statusCode).toBe(200);
    expect(await statusOf(INV[status]!)).toBe('sent');
  });
});
