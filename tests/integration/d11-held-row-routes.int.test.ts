/**
 * D11, through the real routes: a request that waits on a row another transaction holds answers 503 + Retry-After
 * within the 5 s budget (it answered 409 or 400), one case per error CLASS, with nothing committed:
 *   BankTransactionLockTimeoutError   bank-transactions-action allocate, the bank line held
 *   held SupplierPaymentRefusal       bank-transactions-action allocate to a supplier, a bill held
 *   held ReceiptRefusal               bank-transactions-action allocate to a customer, an invoice held
 *   PaymentLockTimeoutError           supplier-allocations, the payment held
 *   CaptureRowLockTimeoutError        receipt-to-journal, the captured document held
 *   CustomerInvoiceLockTimeoutError   payment-gateway enable, the invoice held
 *   VatLockTimeoutError               vat-period-locks lock, a post holding the company's shared VAT lock
 *   RecurringJournalLockTimeoutError  recurring-journals-action generate, the template held
 *   ApprovalRequestLockTimeoutError   approval-requests approve, the request held
 * The payroll classes are pinned in w3-01-calculate-lock-timeout / w3-01-reversal-guard-locks, the vat adjustment's in
 * r051-vat-adjustment-route. A state refusal keeps its answer (a template that does not exist is 404, not 503).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { SignJWT } from 'jose';
import { sql } from '@/lib/neon';
import bankTransactionsAction from '../../pages/api/accounting/bank-transactions-action';
import supplierAllocations from '../../pages/api/accounting/supplier-allocations';
import receiptToJournal from '../../pages/api/accounting/receipt-to-journal';
import paymentGateway from '../../pages/api/accounting/payment-gateway';
import vatPeriodLocks from '../../pages/api/accounting/vat-period-locks';
import recurringJournalsAction from '../../pages/api/accounting/recurring-journals-action';
import approvalRequests from '../../pages/api/accounting/approval-requests';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { request, response } from './mfa-impersonation-postgres.helpers';
import { seedBankTx } from './helpers/l1FifoFixture';
import { postedBill, postedInvoice, processedPayment, setup, teardown, type Ctx } from './d8-r4-helpers';

let c: Ctx;
type Row = Record<string, unknown>;
type Handler = (req: never, res: never) => unknown;
let token = '';
let priorAppUrl: string | undefined;
const one = async (q: Promise<unknown>) => ((await q) as Row[])[0]!;

async function call(route: Handler, method: string, body: Record<string, unknown>) {
  const req = request({ 'sb-access-token': token, active_company_id: c.fx.companyId }, method) as unknown as Row;
  req.body = body;
  req.query = {};
  const out = response();
  const t0 = Date.now();
  await route(req as never, out.res as never);
  return { status: out.state.statusCode, ms: Date.now() - t0, retryAfter: out.headers.get('retry-after') ?? null,
    body: JSON.stringify(out.state.body).slice(0, 300) };
}

/** Another transaction holding `text` for up to 9 s; the returned function lets go early. */
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
const rowLock = (table: string, id: string) => holdFor(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);

interface Case { hold: () => Promise<() => Promise<void>>; run: () => ReturnType<typeof call>; unchanged: () => Promise<void> }
const bankLineStill = (bt: string) => async () => {
  expect((await one(sql`SELECT status FROM bank_transactions WHERE id = ${bt}::UUID`)).status).toBe('imported');
};
const allocateBody = (bt: string, extra: Record<string, unknown>) => ({ action: 'allocate', bankTransactionId: bt, ...extra });
const allocate = (bt: string, extra: Record<string, unknown>) => () =>
  call(bankTransactionsAction as Handler, 'POST', allocateBody(bt, extra));

const cases: Record<string, () => Promise<Case>> = {
  'BankTransactionLockTimeoutError: the bank line': async () => {
    const bt = await seedBankTx(c.fx, { date: '2026-05-22', amount: -100, description: `D11 line ${++c.seq}` });
    return { hold: () => rowLock('bank_transactions', bt), unchanged: bankLineStill(bt),
      run: allocate(bt, { allocationType: 'account', contraAccountId: c.acct.expense }) };
  },
  'held SupplierPaymentRefusal: a bill the line would settle': async () => {
    const bill = await postedBill(c);
    const bt = await seedBankTx(c.fx, { date: '2026-05-22', amount: -1150, description: `D11 pay ${++c.seq}` });
    return { hold: () => rowLock('supplier_invoices', bill.id), unchanged: bankLineStill(bt),
      run: allocate(bt, { allocationType: 'supplier', entityId: c.fx.supplierId }) };
  },
  'held ReceiptRefusal: an invoice the line would settle': async () => {
    const inv = await postedInvoice(c);
    const bt = await seedBankTx(c.fx, { date: '2026-05-22', amount: 1150, description: `D11 rcpt ${++c.seq}` });
    return { hold: () => rowLock('customer_invoices', inv.id), unchanged: bankLineStill(bt),
      run: allocate(bt, { allocationType: 'customer', entityId: c.fx.customerId }) };
  },
  'PaymentLockTimeoutError: the payment': async () => {
    const bill = await postedBill(c);
    const pay = await processedPayment(c, bill.id, 400);
    const allocations = async () => Number((await one(sql`
      SELECT COUNT(*) AS n FROM payment_allocations WHERE payment_id = ${pay.id}::UUID`)).n);
    const before = await allocations();
    return { hold: () => rowLock('supplier_payments', pay.id), unchanged: async () => { expect(await allocations()).toBe(before); },
      run: () => call(supplierAllocations as Handler, 'POST', { paymentId: pay.id, allocations: [{ invoiceId: bill.id, amount: 10 }] }) };
  },
  'CaptureRowLockTimeoutError: the captured document': async () => {
    const doc = String((await one(sql`INSERT INTO captured_documents (company_id, file_name, file_type, status, document_type)
      VALUES (${c.fx.companyId}::UUID, ${`d11-${++c.seq}.pdf`}, 'application/pdf', 'reviewed', 'receipt') RETURNING id`)).id);
    return { hold: () => rowLock('captured_documents', doc), run: () => call(receiptToJournal as Handler, 'POST', { documentId: doc }),
      unchanged: async () => {
        expect((await one(sql`SELECT status FROM captured_documents WHERE id = ${doc}::UUID`)).status).toBe('reviewed');
      } };
  },
  'CustomerInvoiceLockTimeoutError: the invoice': async () => {
    const inv = await postedInvoice(c);
    return { hold: () => rowLock('customer_invoices', inv.id), unchanged: async () => undefined,
      run: () => call(paymentGateway as Handler, 'POST', { invoiceId: inv.id, action: 'enable' }) };
  },
  'VatLockTimeoutError: a post holding the shared VAT lock': async () => ({
    hold: () => holdFor('SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text, 570)) AS l', [c.fx.companyId]),
    run: () => call(vatPeriodLocks as Handler, 'POST', { action: 'lock', periodStart: '2026-03-01', periodEnd: '2026-04-30' }),
    unchanged: async () => {
      expect(Number((await one(sql`SELECT COUNT(*) AS n FROM vat_period_locks WHERE company_id = ${c.fx.companyId}::UUID`)).n)).toBe(0);
    },
  }),
  'RecurringJournalLockTimeoutError: the template': async () => {
    const tpl = String((await one(sql`INSERT INTO recurring_journals (company_id, template_name, frequency, next_run_date, created_by)
      VALUES (${c.fx.companyId}::UUID, ${`d11-${++c.seq}`}, 'monthly', '2026-06-01', ${c.fx.userId}::UUID) RETURNING id`)).id);
    return { hold: () => rowLock('recurring_journals', tpl), run: () => call(recurringJournalsAction as Handler, 'POST', { action: 'generate', id: tpl }),
      unchanged: async () => {
        expect((await one(sql`SELECT status FROM recurring_journals WHERE id = ${tpl}::UUID`)).status).toBe('active');
      } };
  },
  'ApprovalRequestLockTimeoutError: the request': async () => {
    const req = String((await one(sql`INSERT INTO approval_requests (company_id, document_type, document_id, requested_by, status)
      VALUES (${c.fx.companyId}::UUID, 'supplier_invoice', ${randomUUID()}::UUID, ${c.fx.userId}::UUID, 'pending') RETURNING id`)).id);
    return { hold: () => rowLock('approval_requests', req), run: () => call(approvalRequests as Handler, 'POST', { action: 'approve', requestId: req }),
      unchanged: async () => {
        expect((await one(sql`SELECT status FROM approval_requests WHERE id = ${req}::UUID`)).status).toBe('pending');
      } };
  },
};

describe.skipIf(!process.env.DATABASE_URL || !process.env.JWT_SECRET)('D11: every held row is a 503 within the budget', () => {
  beforeAll(async () => {
    assertNotProductionDb('D11 held row routes');
    c = await setup('D11HR');
    priorAppUrl = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.d11.example';
    await sql`INSERT INTO users (id, email, first_name) VALUES (${c.fx.userId}, ${`d11-${c.fx.tag}@example.invalid`}, 'd11')
              ON CONFLICT (id) DO NOTHING`;
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${c.fx.companyId}::UUID, ${c.fx.userId}, 'admin')`;
    token = await new SignJWT({ sub: c.fx.userId, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  }, 120000);
  afterAll(async () => {
    if (c) {
      await sql`UPDATE bank_transactions SET matched_journal_line_id = NULL WHERE company_id = ${c.fx.companyId}::UUID`;
      await sql`DELETE FROM approval_requests WHERE company_id = ${c.fx.companyId}::UUID`;
      await sql`DELETE FROM recurring_journals WHERE company_id = ${c.fx.companyId}::UUID`;
      await sql`DELETE FROM company_users WHERE company_id = ${c.fx.companyId}::UUID`;
    }
    if (priorAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = priorAppUrl;
    await teardown(c);
  }, 120000);

  for (const [name, make] of Object.entries(cases)) {
    it(`${name} held 9 s: 503 + Retry-After within the budget, nothing committed`, async () => {
      const s = await make();
      const release = await s.hold();
      let out: Awaited<ReturnType<typeof call>>;
      try { out = await s.run(); } finally { await release(); }
      expect(out.status, JSON.stringify(out)).toBe(503);
      expect(out.retryAfter).toBe('2');
      expect(out.ms).toBeLessThan(8000);
      expect(out.body).not.toMatch(/aborted/);
      await s.unchanged();
    }, 40000);
  }

  // A refusal about the document's STATE is not a held row: no 503, no Retry-After.
  it('generating from a recurring template that does not exist: still 404, not a 503', async () => {
    const out = await call(recurringJournalsAction as Handler, 'POST', { action: 'generate', id: randomUUID() });
    expect(out.status, JSON.stringify(out)).toBe(404);
    expect(out.retryAfter).toBeNull();
  }, 40000);
});
