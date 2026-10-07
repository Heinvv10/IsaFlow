/**
 * Ledger-date window, round 6 (brk-numrace G1/G2): a route that posts a journal from a STORED document date answers a
 * window refusal 400 with nothing written, however much its service locked or wrote first — the posting call runs in
 * a savepoint (lib/apiJournalDate.withJournalDateRefusal) that is rolled back before the 400.
 *   G1  a supplier credit note dated 2205-01-01, created as a draft, then PATCH post (the note is locked first);
 *   G2  a customer invoice whose date a peer changes to 2205-01-01 and commits while the approve waits on its row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import supplierCreditNotes from '../../pages/api/accounting/supplier-credit-notes';
import customerInvoiceDetail from '../../pages/api/accounting/customer-invoices-detail';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { request, response } from './mfa-impersonation-postgres.helpers';
import { dropFixture, seedInvoice } from './helpers/l1FifoFixture';
import { callRoute, dropRouteUser, seedRouteUser } from './helpers/vatLateClaimRoutes';
import { seedDateFixture, type DateFixture } from './helpers/numraceDateFixture';
import { settle, waitBlockedBy } from './helpers/numraceGate';
import type { NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withJournalDateRefusal } from '@/lib/apiJournalDate';
import { withPlatformAdmin } from '@/lib/auth/withPlatformAdmin';
import { SignJWT } from 'jose';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
let c: DateFixture;
let token = '';
const ADMIN = `numrace-jr-admin-${process.pid}`;

/** brk-numrace H1's shape: write, a wrapped call that swallows its own abort and returns ok, write, answer 200. */
const handBackRoute = (tag: string) => {
  const insert = (what: string) => sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date,
      amount, description, status) VALUES (${c.fx.companyId}::UUID, ${c.fx.bankAccountId}::UUID, '2025-03-01', 1,
      ${`${tag} ${what}`}, 'imported')`;
  return withErrorHandler((async (_req: CompanyAuthedRequest, res: NextApiResponse) => {
    await insert('before');
    const v = await withJournalDateRefusal(res, async () => {
      await insert('inside');
      try { await sql`SELECT 1 / 0`; } catch (err) { void err; } // swallowed: the transaction is now aborted
      return { ok: true as const };
    });
    await insert('after');
    res.status(200).json(v);
  }) as never);
};
const tagged = async (tag: string) => (await sql`SELECT description FROM bank_transactions
  WHERE company_id = ${c.fx.companyId}::UUID AND description LIKE ${`${tag}%`}`) as { description: string }[];

async function patch(handler: unknown, body: Record<string, unknown>) {
  const req = request({ 'sb-access-token': token, active_company_id: c.fx.companyId }, 'PATCH') as never as
    { body: unknown; query: Record<string, string>; url: string };
  req.body = body; req.query = {}; req.url = '/api/accounting/supplier-credit-notes';
  const o = response();
  await (handler as (a: never, b: never) => Promise<unknown>)(req as never, o.res as never);
  return o.state;
}

describeIfDb('ledger-date window: stored-date posting routes answer 400 with nothing written', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    c = await seedDateFixture('NUMRACE-JR', DATABASE_URL!);
    token = await seedRouteUser(c.fx, 'numrace-jr');
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${ADMIN}, ${`${ADMIN}@isaflow.test`}, 'super_admin', true)`;
    await sql`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
        normal_balance, is_active, is_system_account)
      VALUES (${c.fx.companyId}::UUID, '4000', ${`Revenue ${c.fx.tag}`}, 'revenue', 'default_revenue', 'credit', true, true)`;
  }, 60000);
  afterAll(async () => {
    await sql`DELETE FROM credit_note_items WHERE credit_note_id IN (
      SELECT id FROM credit_notes WHERE company_id = ${c.fx.companyId}::UUID)`.catch(() => undefined);
    await sql`DELETE FROM credit_notes WHERE company_id = ${c.fx.companyId}::UUID`.catch(() => undefined);
    await sql`DELETE FROM users WHERE id = ${ADMIN}`.catch(() => undefined);
    await dropRouteUser(c.fx).catch(() => undefined);
    await dropFixture(c.fx).catch(() => undefined);
  }, 60000);

  it('G1: a supplier credit note dated 2205-01-01, PATCH post: 400, still draft, no journal', async () => {
    const created = await callRoute(c.fx, token, supplierCreditNotes, {
      supplierId: c.fx.supplierId, creditDate: '2205-01-01', description: 'NRJR G1', submitAction: 'draft',
      lineItems: [{ description: 'x', quantity: 1, unitPrice: 100, vatType: 'standard' }],
    });
    const id = String((created.body as { data?: { id?: string } }).data?.id ?? '');
    const posted = await patch(supplierCreditNotes, { id, action: 'post' });
    const cn = (await sql`SELECT status, gl_journal_entry_id FROM credit_notes WHERE id = ${id}::UUID`) as
      { status: string; gl_journal_entry_id: string | null }[];
    process.stdout.write(`JR-G1 ${JSON.stringify({ create: created.statusCode, post: posted, cn })}\n`);
    expect(created.statusCode, JSON.stringify(created.body)).toBeLessThan(300);
    expect(posted.statusCode, JSON.stringify(posted.body)).toBe(400);
    expect(JSON.stringify(posted.body)).toMatch(/outside 1900-01-01 to 2199-12-31/);
    expect(cn[0]).toEqual({ status: 'draft', gl_journal_entry_id: null });
  }, 60000);

  it('G2: the invoice date changed to 2205-01-01 by a peer while the approve waits on the row: 400, still draft', async () => {
    const id = await seedInvoice(c.fx, { number: 'NRJR-G2', date: '2025-06-01', total: 100, status: 'draft' });
    await sql`INSERT INTO customer_invoice_items (invoice_id, description, unit_price, quantity, amount, tax_rate)
      VALUES (${id}::UUID, 'nrjr', 100, 1, 100, 0)`;
    const p = await c.fx.pool.connect();
    await p.query('BEGIN');
    await p.query('SELECT id FROM customer_invoices WHERE id = $1 FOR UPDATE', [id]);
    const pid = Number((await p.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    try {
      const pending = settle(callRoute(c.fx, token, customerInvoiceDetail, { id, action: 'approve' }));
      await waitBlockedBy(c.fx.pool, pid);
      await p.query(`UPDATE customer_invoices SET invoice_date = '2205-01-01' WHERE id = $1`, [id]);
      await p.query('COMMIT');
      const r = await pending;
      const inv = (await sql`SELECT status, gl_journal_entry_id FROM customer_invoices WHERE id = ${id}::UUID`) as
        { status: string; gl_journal_entry_id: string | null }[];
      process.stdout.write(`JR-G2 ${JSON.stringify({ r: r.ok ? r.value : r, inv })}\n`);
      expect(r.ok && r.value.statusCode, JSON.stringify(r)).toBe(400);
      expect(inv[0]).toEqual({ status: 'draft', gl_journal_entry_id: null });
    } finally {
      await p.query('ROLLBACK').catch(() => undefined);
      p.release();
    }
  }, 60000);

  // brk-numrace H1: a call that RETURNS on a transaction it aborted itself is handed back by the savepoint helper
  // (k071's 'contended' → 503), but the request is marked rollback-only: nothing in it commits, whatever it answers.
  it('H1: a call that swallows an abort and returns ok: nothing commits (the earlier write included), 500', async () => {
    const tag = `NRJR-H1 ${c.fx.tag}`;
    const out = await callRoute(c.fx, token, withAuth(handBackRoute(tag)) as never, {});
    const rows = await tagged(tag);
    process.stdout.write(`JR-H1 ${JSON.stringify({ status: out.statusCode, body: out.body, rows })}\n`);
    expect(out.statusCode).toBe(500);
    expect(rows).toEqual([]);
  }, 60000);

  // brk-numrace R1: withPlatformAdmin (sage-commit's owner) rolled back, but the route's 200 had already gone out.
  it('R1: the same under withPlatformAdmin: the client gets 500 COMMIT_FAILED, nothing commits', async () => {
    const tag = `NRJR-R1 ${c.fx.tag}`;
    const adminToken = await new SignJWT({ sub: ADMIN, aud: 'authenticated', role: 'authenticated', aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
    const wire: Array<{ status: number; body: unknown }> = [];
    const res = {
      statusCode: 200, headersSent: false,
      status(code: number) { this.statusCode = code; return this; },
      setHeader() { return this; }, getHeader() { return undefined; }, removeHeader() { /* replaced answers drop headers */ },
      json(body: unknown) { return this.end(JSON.stringify(body)); },
      end(body?: unknown) { wire.push({ status: this.statusCode, body: body === undefined ? null : JSON.parse(String(body)) }); return this; },
    };
    await withPlatformAdmin(handBackRoute(tag))(
      { headers: { cookie: `sb-access-token=${adminToken}` }, url: '/api/admin/numrace-r1', method: 'POST' } as never, res as never);
    const rows = await tagged(tag);
    process.stdout.write(`JR-R1 ${JSON.stringify({ wire, rows })}\n`);
    expect(wire).toEqual([{ status: 500, body: expect.objectContaining({ success: false, code: 'COMMIT_FAILED' }) }]);
    expect(rows).toEqual([]);
  }, 60000);
});
