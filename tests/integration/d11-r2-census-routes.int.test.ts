/**
 * D11 round 2 (brk-d11 F2, F3), through the real routes: a row another transaction holds, or a deadlock the route loses,
 * answers 503 + Retry-After with nothing committed. The document-number row (DocumentNumberLockTimeoutError) held 9 s
 * on three routes that answered 400 / 500, and a raw 40P01 victim on journal-entries-action (was 400 "deadlock
 * detected"). Each case first proves the same request succeeds with nothing held.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { SignJWT } from 'jose';
import { sql } from '@/lib/neon';
import supplierInvoices from '../../pages/api/accounting/supplier-invoices';
import customerInvoicesCreate from '../../pages/api/accounting/customer-invoices-create';
import supplierReturns from '../../pages/api/accounting/supplier-returns';
import journalEntriesAction from '../../pages/api/accounting/journal-entries-action';
import { ensureDocumentNumbers } from '@/modules/accounting/services/core/companySettingsService';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { request, response } from './mfa-impersonation-postgres.helpers';
import { inTx } from './helpers/l1FifoFixture';
import { setup, teardown, sleep, type Ctx } from './d8-r4-helpers';

let c: Ctx;
type Row = Record<string, unknown>;
type Handler = (req: never, res: never) => unknown;
let token = '';
const one = async (q: Promise<unknown>) => ((await q) as Row[])[0]!;

async function call(route: Handler, method: string, body: Record<string, unknown>) {
  const req = request({ 'sb-access-token': token, active_company_id: c.fx.companyId }, method) as unknown as Row;
  req.body = body;
  req.query = {};
  const out = response();
  const t0 = Date.now();
  await route(req as never, out.res as never);
  return { status: out.state.statusCode, ms: Date.now() - t0, retryAfter: out.headers.get('retry-after') ?? null,
    body: JSON.stringify(out.state.body).slice(0, 400) };
}

async function holdFor(text: string, params: unknown[]) {
  const cl: PoolClient = await c.fx.pool.connect();
  await cl.query('BEGIN');
  if (!(await cl.query(text, params)).rowCount) throw new Error(`holder locked nothing: ${text}`);
  let done = false;
  const release = async () => {
    if (done) return;
    done = true;
    await cl.query('ROLLBACK');
    cl.release();
  };
  const timer = setTimeout(() => { void release(); }, 9000);
  return async () => { clearTimeout(timer); await release(); };
}
const holdDocNumber = (type: string) => holdFor(
  'SELECT document_type FROM company_document_numbers WHERE company_id = $1::UUID AND document_type = $2 FOR UPDATE',
  [c.fx.companyId, type]);

const count = async (table: string) =>
  Number((await one(sql.query(`SELECT COUNT(*) AS n FROM ${table} WHERE company_id = $1::UUID`, [c.fx.companyId]))).n);

describe.skipIf(!process.env.DATABASE_URL || !process.env.JWT_SECRET)('D11 round 2: held rows and deadlock victims answer 503', () => {
  beforeAll(async () => {
    assertNotProductionDb('D11 round 2');
    c = await setup('D11R2');
    await sql`INSERT INTO users (id, email, first_name) VALUES (${c.fx.userId}, ${`d11r2-${c.fx.tag}@example.invalid`}, 'd11r2')
              ON CONFLICT (id) DO NOTHING`;
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${c.fx.companyId}::UUID, ${c.fx.userId}, 'admin')`;
    await ensureDocumentNumbers(c.fx.companyId);
    token = await new SignJWT({ sub: c.fx.userId, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  }, 120000);
  afterAll(async () => {
    if (c) {
      await sql`DELETE FROM credit_notes WHERE company_id = ${c.fx.companyId}::UUID`;
      await sql`DELETE FROM company_document_numbers WHERE company_id = ${c.fx.companyId}::UUID`;
      await sql`DELETE FROM company_users WHERE company_id = ${c.fx.companyId}::UUID`;
    }
    await teardown(c);
  }, 120000);

  const docNumberCases: Array<[string, string, string, () => Handler, () => Record<string, unknown>]> = [
    ['supplier-invoices POST (useSequence)', 'supplier_invoice', 'supplier_invoices', () => supplierInvoices as Handler, () => ({
      supplierId: c.fx.supplierId, invoiceDate: '2026-05-10', useSequence: true,
      items: [{ description: 'brk', quantity: 1, unitPrice: 100, glAccountId: c.acct.expense }] })],
    ['customer-invoices-create POST', 'customer_invoice', 'customer_invoices', () => customerInvoicesCreate as Handler, () => ({
      clientId: c.fx.customerId, invoiceDate: '2026-05-10', dueDate: '2026-06-10',
      items: [{ description: 'brk', quantity: 1, unitPrice: 100, glAccountId: c.acct.sales }] })],
    ['supplier-returns POST', 'supplier_return', 'credit_notes', () => supplierReturns as Handler, () => ({
      supplierId: c.fx.supplierId, amount: 100, reason: 'brk' })],
  ];
  for (const [name, type, table, route, body] of docNumberCases) {
    it(`${name}: the ${type} number row held 9 s`, async () => {
      const before = await count(table);
      // Control: the same request with nothing held must succeed, or the held answer proves nothing.
      const release = await holdDocNumber(type);
      let out: Awaited<ReturnType<typeof call>>;
      try { out = await call(route(), 'POST', body()); } finally { await release(); }
      const after = await count(table);
      const control = await call(route(), 'POST', body());
      expect(control.status, `control ${JSON.stringify(control)}`).toBeLessThan(300);
      expect(after - before).toBe(0);
      expect(out.status, JSON.stringify(out)).toBe(503);
      expect(out.retryAfter).toBe('2');
    }, 40000);
  }

  // A deadlock victim on a D8/D11 route: journal-entries-action post takes the header FOR UPDATE, then the company's
  // shared VAT advisory lock (unbounded). The holder holds the EXCLUSIVE VAT key, waits for the route to block on it,
  // then asks for the header: a cycle the route (waiting first) detects at deadlock_timeout and loses — 40P01.
  it('journal-entries-action post: a 40P01 deadlock victim', async () => {
    const je = await inTx(c.fx, () => createJournalEntry(c.fx.companyId, {
      entryDate: '2026-05-12', description: 'brk-d11 deadlock',
      lines: [{ glAccountId: c.acct.expense!, debit: 50, credit: 0 }, { glAccountId: c.fx.bankAccountId, debit: 0, credit: 50 }],
    }, c.fx.userId));
    const jeId = String((je as { id: string }).id);
    const h: PoolClient = await c.fx.pool.connect();
    await h.query('BEGIN');
    await h.query("SET LOCAL deadlock_timeout = '20s'");
    await h.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 570))', [c.fx.companyId]);
    const pending = call(journalEntriesAction as Handler, 'POST', { id: jeId, action: 'post' });
    let waited = false;
    for (let i = 0; i < 100 && !waited; i++) {
      await sleep(30);
      const r = await h.query(`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND pid <> pg_backend_pid()`);
      waited = (r.rowCount ?? 0) > 0;
    }
    let holderErr: string | null = null;
    const holderWants = h.query('SELECT id FROM gl_journal_entries WHERE id = $1::UUID FOR UPDATE', [jeId])
      .catch((e: Error & { code?: string }) => { holderErr = `${e.code} ${e.message}`; });
    const out = await pending;
    await holderWants;
    await h.query('ROLLBACK');
    h.release();
    const status = String((await one(sql`SELECT status FROM gl_journal_entries WHERE id = ${jeId}::UUID`)).status);
    expect(waited).toBe(true);
    expect(holderErr).toBeNull();
    expect(status).toBe('draft');
    expect(out.status, JSON.stringify(out)).toBe(503);
    expect(out.retryAfter).toBe('2');
  }, 40000);

});
