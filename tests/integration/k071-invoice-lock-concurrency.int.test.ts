/**
 * K-071 (round-5 LOW-1) — two receipts against ONE invoice, on real SQL.
 *
 * Nothing on the settlement path used to lock `customer_invoices`.
 * `lockCustomerPaymentForUpdate` protects the RECEIPT's remainder (and locks a
 * row this request has just created, so it never contends), and `bankTxLock`
 * protects a bank LINE — a different row for each of two requests. So the
 * check-then-act on `amount_paid` had no lock across it at all: two lines
 * confirmed against one invoice both read the same outstanding and both passed.
 *
 * Measured before the fix, over eight interleavings with two pool clients: the
 * books never over-applied, but only because the second request collided on
 * `uq_gl_je_company_entry_number` inside `createJournalEntry` and was rolled
 * back — the money path's safety resting on an index that exists to number
 * journals, and the user seeing a bare 500 where the same request 20ms later
 * got the actionable 400.
 *
 * `fetchInvoiceCandidates` now takes `FOR UPDATE OF ci` under a 5s
 * `lock_timeout`. Both directions are pinned: the loser REFUSES with the
 * remedy (not a 500, and not an over-application), and a held lock times out
 * into a retry refusal that has written nothing.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  cleanupK074, confirmMatch, seedBankLine, seedInvoice, seedK074, type K074Fixture,
} from './helpers/k074Fixture';

vi.mock('@/lib/auth', () => ({
  withAuth: (fn: unknown) => fn,
  withWriteAccess: (fn: unknown) => fn,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let fx: K074Fixture;

beforeAll(async () => { fx = await seedK074(pool); });
afterAll(async () => {
  try { await cleanupK074(pool, fx); } finally { await pool.end(); }
});

async function amountPaid(invoiceId: string): Promise<number> {
  const { rows } = await pool.query(
    'SELECT amount_paid FROM customer_invoices WHERE id=$1', [invoiceId],
  );
  return Number(rows[0].amount_paid);
}

async function receiptCount(invoiceId: string): Promise<number> {
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM customer_payment_allocations WHERE invoice_id=$1', [invoiceId],
  );
  return rows[0].n as number;
}

function body(bankTransactionId: string, candidateId: string) {
  return { bankTransactionId, candidateType: 'customer_invoice', candidateId };
}

it('two receipts racing one invoice: one settles, the other refuses with the remedy', async () => {
  const invoice = await seedInvoice(pool, fx, 1000);
  const lineA = await seedBankLine(pool, fx, 600);
  const lineB = await seedBankLine(pool, fx, 600);

  // Two real pool clients, started together. Whichever reaches
  // fetchInvoiceCandidates first holds the invoice row for the rest of its
  // transaction; the other blocks there and then re-reads amount_paid under the
  // lock, which is what turns a collision into a refusal.
  const [a, b] = await Promise.all([
    confirmMatch(pool, fx, body(lineA, invoice)),
    confirmMatch(pool, fx, body(lineB, invoice)),
  ]);

  const statuses = [a.status, b.status].sort();
  expect(statuses).toEqual([200, 400]);
  // The point of the fix: the loser is REFUSED, not failed. A 500 here is the
  // pre-fix JE-numbering collision.
  expect(statuses).not.toContain(500);

  const refused = a.status === 400 ? a : b;
  expect(JSON.stringify(refused.body)).toMatch(/R400\.00 outstanding|only R400\.00/);

  // The books: exactly one application of R600, and the invoice is not
  // over-credited.
  expect(await amountPaid(invoice)).toBe(600);
  expect(await receiptCount(invoice)).toBe(1);
});

it('a held invoice lock times out into a retry refusal that wrote nothing', async () => {
  const invoice = await seedInvoice(pool, fx, 1000);
  const line = await seedBankLine(pool, fx, 400);

  // A second pool client holds the invoice row exactly as a concurrent
  // settlement would, for longer than the 5s lock_timeout.
  const holder = await pool.connect();
  let result;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM customer_invoices WHERE id=$1 FOR UPDATE', [invoice]);
    result = await confirmMatch(pool, fx, body(line, invoice));
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }

  expect(result.status).toBe(400);
  expect(JSON.stringify(result.body)).toMatch(/retry in a moment/i);
  // Refused before the first write, so the 400 withAuth COMMITs commits nothing.
  expect(await amountPaid(invoice)).toBe(0);
  expect(await receiptCount(invoice)).toBe(0);
  const { rows } = await pool.query(
    'SELECT status FROM bank_transactions WHERE id=$1', [line],
  );
  expect(rows[0].status).toBe('imported');
}, 20000);
