/**
 * K-071 (round-6 MEDIUM-3) — two payments against ONE bill, on real SQL.
 *
 * The AP mirror of `k071-invoice-lock-concurrency.int.test.ts`, and the same
 * defect. Round 5 locked `customer_invoices` in `fetchInvoiceCandidates` and
 * left the AP half — rewritten by the same commit — reading
 * `supplier_invoices.amount_paid` with no lock across the check-then-act:
 * `outstandingBefore` is read in `fetchBillCandidates`, the over-payment guard
 * is decided from it in `buildLine`, and the column is moved much later.
 * Nothing else on the AP path locks the bill — `lockSupplierPaymentForUpdate`
 * protects a payment the same transaction just created, and `bankTxLock`
 * protects a bank LINE, a different row per request.
 *
 * `fetchBillCandidates` now takes `FOR UPDATE OF si` under a 5s `lock_timeout`,
 * ordered by `si.id`. Both directions are pinned: the loser REFUSES with the
 * remedy rather than colliding on `uq_gl_je_company_entry_number` and answering
 * 500, and a held lock times out into a retry refusal that has written nothing.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  cleanupK074, confirmMatch, seedBankLine, seedBill, seedK074, type K074Fixture,
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

async function amountPaid(billId: string): Promise<number> {
  const { rows } = await pool.query(
    'SELECT amount_paid FROM supplier_invoices WHERE id=$1', [billId],
  );
  return Number(rows[0].amount_paid);
}

async function allocationCount(billId: string): Promise<number> {
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM payment_allocations WHERE invoice_id=$1', [billId],
  );
  return rows[0].n as number;
}

function body(bankTransactionId: string, candidateId: string) {
  return { bankTransactionId, candidateType: 'supplier_invoice', candidateId };
}

it('two payments racing one bill: one settles, the other refuses with the remedy', async () => {
  const bill = await seedBill(pool, fx, 1000);
  // Negative: money out of the bank. Direction is derived from the sign.
  const lineA = await seedBankLine(pool, fx, -600);
  const lineB = await seedBankLine(pool, fx, -600);

  const [a, b] = await Promise.all([
    confirmMatch(pool, fx, body(lineA, bill)),
    confirmMatch(pool, fx, body(lineB, bill)),
  ]);

  const statuses = [a.status, b.status].sort();
  expect(statuses).toEqual([200, 400]);
  // The point of the fix: the loser is REFUSED, not failed. A 500 here is the
  // pre-fix JE-numbering collision that was the only thing stopping it.
  expect(statuses).not.toContain(500);

  const refused = a.status === 400 ? a : b;
  expect(JSON.stringify(refused.body)).toMatch(/R400\.00 outstanding|only R400\.00/);

  // The books: exactly one application of R600, and the bill is not over-paid.
  expect(await amountPaid(bill)).toBe(600);
  expect(await allocationCount(bill)).toBe(1);
});

it('a held bill lock times out into a retry refusal that wrote nothing', async () => {
  const bill = await seedBill(pool, fx, 1000);
  const line = await seedBankLine(pool, fx, -400);

  const holder = await pool.connect();
  let result;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM supplier_invoices WHERE id=$1 FOR UPDATE', [bill]);
    result = await confirmMatch(pool, fx, body(line, bill));
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }

  // 409, not 400: a peer holding the bill row is contention, not the caller's
  // mistake, and 400 is the status this codebase reserves for the latter and
  // monitors as such. Same status the route answers when the peer holds the
  // BANK LINE instead — one event, one answer, on every screen.
  expect(result.status).toBe(409);
  expect(JSON.stringify(result.body)).toMatch(/retry in a moment/i);
  // Refused before the first write, so the 4xx withAuth COMMITs commits nothing.
  expect(await amountPaid(bill)).toBe(0);
  expect(await allocationCount(bill)).toBe(0);
  const { rows } = await pool.query(
    'SELECT status FROM bank_transactions WHERE id=$1', [line],
  );
  expect(rows[0].status).toBe('imported');
}, 20000);
