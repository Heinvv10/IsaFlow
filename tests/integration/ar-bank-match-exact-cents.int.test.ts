/**
 * bank-match-confirm (customer branch) judges "already fully paid" in whole cents.
 *
 * It refused an invoice owing one cent ("already fully paid") while the invoice row read 'partially_paid', so the
 * last cent could not be cleared from the bank line that paid it. Asserted by OUTCOME: the HTTP status and the
 * invoice row after the request.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupK074, confirmMatch, seedBankLine, seedInvoice, seedK074, type K074Fixture } from './helpers/k074Fixture';

vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let fx: K074Fixture;

beforeAll(async () => { fx = await seedK074(pool); });
afterAll(async () => {
  try { await cleanupK074(pool, fx); } finally { await pool.end(); }
});

async function invoiceRow(id: string) {
  const { rows } = await pool.query('SELECT amount_paid::float8 AS paid, status, paid_at FROM customer_invoices WHERE id=$1', [id]);
  return rows[0] as { paid: number; status: string; paid_at: Date | null };
}

it('a bank line clears the last cent of an invoice: invoice paid and dated', async () => {
  const invoice = await seedInvoice(pool, fx, 115);
  await pool.query("UPDATE customer_invoices SET amount_paid = 114.99, status = 'partially_paid' WHERE id=$1", [invoice]);
  const bankTx = await seedBankLine(pool, fx, 0.01);

  const { status, committed } = await confirmMatch(pool, fx, {
    bankTransactionId: bankTx, candidateType: 'customer_invoice', candidateId: invoice,
  });

  expect(status).toBe(200);
  expect(committed).toBe(true);
  const row = await invoiceRow(invoice);
  expect(row).toMatchObject({ paid: 115, status: 'paid' });
  expect(row.paid_at).toBeTruthy();
});

it('an invoice owing nothing is still refused as fully paid', async () => {
  const invoice = await seedInvoice(pool, fx, 115);
  await pool.query("UPDATE customer_invoices SET amount_paid = 115, status = 'approved' WHERE id=$1", [invoice]);
  const bankTx = await seedBankLine(pool, fx, 0.01);

  const { status } = await confirmMatch(pool, fx, {
    bankTransactionId: bankTx, candidateType: 'customer_invoice', candidateId: invoice,
  });

  expect(status).toBe(400);
  expect(await invoiceRow(invoice)).toMatchObject({ paid: 115 });
});
