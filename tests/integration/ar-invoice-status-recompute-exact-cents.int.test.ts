/**
 * recomputeInvoiceStatus (customer) derives status and paid_at in whole cents, like receipt confirm/cancel.
 *
 * It used `amount_paid >= total_amount - 0.01` for 'paid' and `amount_paid > 0.01` for 'partially_paid', so an
 * invoice with one cent still owing read 'paid' (and was dated), and one with exactly one cent paid stayed
 * 'approved'. Driven through a real caller (write-off approval) and asserted by the invoice row's outcome.
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

async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, userId: fx.user, companyId: fx.company, claims: {} }, fn);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Write `amount` off `invoiceId` (create + approve), which ends in recomputeInvoiceStatus. */
async function writeOff(invoiceId: string, amount: number): Promise<void> {
  const wo = await inTx(() => createWriteOff(fx.company, {
    clientId: fx.customer, invoiceId, amount, reason: 'bad debt', writeOffDate: '2026-05-15',
  } as never, fx.user));
  await inTx(() => approveWriteOff(fx.company, wo.id, fx.user));
}

async function invoice(id: string): Promise<{ status: string; paidAt: Date | null; paid: number }> {
  const { rows } = await pool.query(
    'SELECT status, paid_at, amount_paid::float8 AS paid FROM customer_invoices WHERE id=$1', [id]);
  return { status: rows[0].status, paidAt: rows[0].paid_at, paid: rows[0].paid };
}

describe('recomputeInvoiceStatus (customer), whole cents', () => {
  it('a cent still owing is partially_paid and undated', async () => {
    const id = await seedInvoice(pool, fx, 115);
    await writeOff(id, 114.99);
    expect(await invoice(id)).toEqual({ status: 'partially_paid', paidAt: null, paid: 114.99 });
  });

  it('exactly one cent paid is partially_paid, not left approved', async () => {
    const id = await seedInvoice(pool, fx, 115);
    await writeOff(id, 0.01);
    expect(await invoice(id)).toEqual({ status: 'partially_paid', paidAt: null, paid: 0.01 });
  });

  it('nothing owing is paid and dated', async () => {
    const id = await seedInvoice(pool, fx, 115);
    await writeOff(id, 115);
    const row = await invoice(id);
    expect(row.status).toBe('paid');
    expect(row.paidAt).toBeInstanceOf(Date);
    expect(row.paid).toBe(115);
  });
});
