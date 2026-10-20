/**
 * AR audit 2026-10-18, B1/B2 review round 1 — what else a receipt create/confirm must refuse, on real SQL.
 *
 *  - cross-path: a draft RECEIPT and a draft WRITE-OFF each claim the whole invoice; the write-off is approved
 *    (it ignores draft receipts), then the receipt is confirmed. The invoice must absorb the money once.
 *  - the same invoice twice in one receipt is refused up front (it would otherwise die on the
 *    (payment_id, invoice_id) unique constraint with raw constraint text);
 *  - an allocation that is not a whole number of cents is refused by the service, so create and confirm cannot
 *    disagree about it (the route's zod schema is not the only caller: settle_by_contra, tests, scripts);
 *  - B5: an allocation to a soft-deleted invoice, or to one that has posted no AR (draft, pending approval,
 *    cancelled), is refused at create.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupK074, seedInvoice, seedK074, type K074Fixture } from './helpers/k074Fixture';

vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));

import { als } from '@/lib/als';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { createCustomerPayment, confirmCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentService';
import { approveWriteOff, createWriteOff } from '@/modules/accounting/services/ar/writeOffService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let fx: K074Fixture;

beforeEach(async () => {
  fx = await seedK074(pool);
  await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account)
     VALUES ($1,'ADM001','Admin expenses','expense','admin_expense','debit',true,true)`, [fx.company]);
  clearSystemAccountCache(fx.company);
});
afterEach(async () => {
  await pool.query('DELETE FROM customer_write_offs WHERE company_id=$1', [fx.company]);
  await cleanupK074(pool, fx);
});

/** One request transaction, committed unless the callback throws (what withAuth does for a 4xx). */
async function inTx<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: Error }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, userId: fx.user, companyId: fx.company, claims: {} }, async () => {
      try { return { value: await fn() }; } catch (error) { return { error: error as Error }; }
    });
    await client.query('COMMIT');
    return out;
  } finally {
    client.release();
  }
}

const receipt = (invoiceId: string, amount: number, extra: { invoiceId: string; amount: number }[] = []) =>
  inTx(() => createCustomerPayment(fx.company, {
    clientId: fx.customer, paymentDate: '2026-05-15', totalAmount: amount + extra.reduce((s, a) => s + a.amount, 0),
    paymentMethod: 'eft', bankAccountId: fx.bankAccount,
    allocations: [{ invoiceId, amount }, ...extra],
  }, fx.user));

async function amountPaid(invoiceId: string): Promise<number> {
  return (await pool.query('SELECT amount_paid::float8 AS p FROM customer_invoices WHERE id=$1', [invoiceId])).rows[0].p as number;
}
async function arCredits(): Promise<number> {
  return (await pool.query(
    `SELECT COALESCE(SUM(l.credit), 0)::float8 AS c FROM gl_journal_lines l
       JOIN gl_journal_entries e ON e.id = l.journal_entry_id
      WHERE e.company_id = $1 AND e.status = 'posted' AND l.gl_account_id = $2`, [fx.company, fx.arAccount])).rows[0].c as number;
}
async function paymentCount(): Promise<number> {
  return (await pool.query('SELECT count(*)::int AS n FROM customer_payments WHERE company_id=$1', [fx.company])).rows[0].n as number;
}

describe('cross-path: draft receipt + draft write-off for the whole invoice', () => {
  it('after the write-off is approved, confirming the receipt is refused: paid once, AR credited once', async () => {
    const invoice = await seedInvoice(pool, fx, 1150);
    const draft = await receipt(invoice, 1150);
    expect(draft.error).toBeUndefined();
    const wo = await inTx(() => createWriteOff(fx.company, {
      clientId: fx.customer, invoiceId: invoice, amount: 1150, reason: 'bad debt', writeOffDate: '2026-05-15',
    } as never, fx.user));
    expect(wo.error).toBeUndefined();
    const approved = await inTx(() => approveWriteOff(fx.company, wo.value!.id, fx.user));
    expect(approved.error).toBeUndefined();
    expect(await amountPaid(invoice)).toBe(1150);

    const confirmed = await inTx(() => confirmCustomerPayment(fx.company, draft.value!.id, fx.user));

    expect(await amountPaid(invoice)).toBe(1150);
    expect(await arCredits()).toBe(1150);
    expect(confirmed.error?.message).toMatch(/exceeds invoice balance R0\.00/);
    const { rows } = await pool.query('SELECT status FROM customer_payments WHERE id=$1', [draft.value!.id]);
    expect(rows[0].status).toBe('draft');
  });
});

describe('create refusals, all before any write', () => {
  it('the same invoice twice in one receipt: a clear refusal, not the unique-constraint text', async () => {
    const invoice = await seedInvoice(pool, fx, 1000);

    const res = await receipt(invoice, 400, [{ invoiceId: invoice, amount: 600 }]);

    expect(await paymentCount()).toBe(0);
    expect(res.error?.message).toMatch(/more than once/i);
    expect(res.error?.message).not.toMatch(/duplicate key|violates|constraint/i);
  });

  it('an allocation that is not whole cents', async () => {
    const invoice = await seedInvoice(pool, fx, 1150);

    const res = await receipt(invoice, 1150.005);

    expect(await paymentCount()).toBe(0);
    expect(res.error?.message).toMatch(/whole number of cents/i);
  });

  it.each([
    ['soft-deleted', { deleted: true }],
    ['draft', { status: 'draft' }],
    ['pending_approval', { status: 'pending_approval' }],
    ['cancelled', { status: 'cancelled' }],
  ])('an allocation to a %s invoice', async (_name, how: { deleted?: boolean; status?: string }) => {
    const invoice = await seedInvoice(pool, fx, 1000, { status: how.status ?? 'approved' });
    if (how.deleted) await pool.query('UPDATE customer_invoices SET deleted_at = now() WHERE id=$1', [invoice]);

    const res = await receipt(invoice, 1000);

    expect(await paymentCount()).toBe(0);
    expect(res.error?.message).toMatch(/cannot take this receipt/i);
  });

  it('a sent invoice still takes a receipt (the refusal is the population rule, not "approved only")', async () => {
    const invoice = await seedInvoice(pool, fx, 1000, { status: 'sent' });

    const res = await receipt(invoice, 1000);

    expect(res.error).toBeUndefined();
    expect(await paymentCount()).toBe(1);
  });
});
