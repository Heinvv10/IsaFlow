/**
 * K-074 adjacent cases — what the supplier branch must REFUSE, and what it must
 * do when a write fails after the journal has posted.
 *
 * The route answers a refusal from READS (`validateBankSupplierPayment`) with a
 * 4xx carrying its own remedy, and anything that throws after the first write
 * with a 500, because `withAuth` COMMITs on `statusCode < 500`. Both halves are
 * under test here: the refusals run the real path and assert nothing was
 * written, and the post-write failure is forced by making the LAST step of the
 * settlement throw — the journal and the payment document are real by then, so
 * the rollback is what has to remove them.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  cleanupK074, confirmMatch, seedBankLine, seedBill, seedK074, type K074Fixture,
} from './helpers/k074Fixture';

/** Flipped on for the one test that needs the settlement's last step to fail. */
const applyFails = { on: false };

vi.mock('@/modules/accounting/services/ap/supplierPaymentApplicationService', async (orig) => {
  const actual = await orig<typeof import(
    '@/modules/accounting/services/ap/supplierPaymentApplicationService'
  )>();
  return {
    ...actual,
    applySupplierPaymentPlan: async (...args: Parameters<typeof actual.applySupplierPaymentPlan>) => {
      if (applyFails.on) throw new Error('subledger apply exploded');
      return actual.applySupplierPaymentPlan(...args);
    },
  };
});


// The handler is the default export, so the wrappers come with it. withAuth's
// transaction is what `confirmMatch` reimplements (it must decide COMMIT vs
// ROLLBACK itself to observe the status-code rule); CSRF and the error handler
// are request plumbing this test does not exercise.
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

async function counts(bankTxId: string) {
  const { rows } = await pool.query(
    `SELECT (SELECT COUNT(*) FROM supplier_payments WHERE reference = $1)::int AS payments,
            (SELECT COUNT(*) FROM gl_journal_entries WHERE company_id = $2)::int AS journals`,
    [bankTxId, fx.company],
  );
  return rows[0] as { payments: number; journals: number };
}

async function billRow(id: string) {
  const { rows } = await pool.query(
    'SELECT amount_paid, status FROM supplier_invoices WHERE id=$1', [id],
  );
  return rows[0];
}

it('answers 500 — not a committing 400 — when the settlement throws after the GL post', async () => {
  const bill = await seedBill(pool, fx, 800);
  const bankTx = await seedBankLine(pool, fx, -800);
  const before = await counts(bankTx);

  applyFails.on = true;
  try {
    const { status, committed } = await confirmMatch(pool, fx, {
      bankTransactionId: bankTx, candidateType: 'supplier_invoice', candidateId: bill,
    });
    // 500 is what makes withAuth ROLLBACK. A 400 here committed the journal and
    // the payment document with the bill still unpaid.
    expect(status).toBe(500);
    expect(committed).toBe(false);
  } finally { applyFails.on = false; }

  const after = await counts(bankTx);
  expect(after.journals).toBe(before.journals);
  expect(after.payments).toBe(0);
  expect(Number((await billRow(bill)).amount_paid)).toBe(0);
});

it('refuses a cancelled bill, and writes nothing', async () => {
  const bill = await seedBill(pool, fx, 900, { status: 'cancelled' });
  const bankTx = await seedBankLine(pool, fx, -900);
  const before = await counts(bankTx);

  const { status, body } = await confirmMatch(pool, fx, {
    bankTransactionId: bankTx, candidateType: 'supplier_invoice', candidateId: bill,
  });

  // MEDIUM-1: the old inline UPDATE carried no status filter and would have
  // stamped this bill 'paid'. The settlement path refuses it instead.
  expect(status).toBe(400);
  expect(JSON.stringify(body)).toMatch(/cancelled/i);
  expect(await counts(bankTx)).toEqual({ payments: 0, journals: before.journals });
  expect((await billRow(bill)).status).toBe('cancelled');
  expect(Number((await billRow(bill)).amount_paid)).toBe(0);
});

it('refuses an already-allocated line with the reason, not a bare 500', async () => {
  const bill = await seedBill(pool, fx, 700);
  const bankTx = await seedBankLine(pool, fx, -700);
  await pool.query("UPDATE bank_transactions SET status='allocated' WHERE id=$1", [bankTx]);

  const { status, body } = await confirmMatch(pool, fx, {
    bankTransactionId: bankTx, candidateType: 'supplier_invoice', candidateId: bill,
  });

  // MEDIUM-2: an actionable, user-fixable refusal keeps its message. Answering
  // every failure with internalError would have hidden this behind "An internal
  // error occurred" in the FindMatchModal, whose only feedback is that string.
  expect(status).toBe(400);
  expect(JSON.stringify(body)).toMatch(/cannot be allocated/i);
  expect(await counts(bankTx)).toMatchObject({ payments: 0 });
});

it('refuses a bill in another tenant without touching it', async () => {
  const foreign = await seedBill(pool, fx, 1150, { companyId: fx.otherCompany });
  const bankTx = await seedBankLine(pool, fx, -1150);

  const { status } = await confirmMatch(pool, fx, {
    bankTransactionId: bankTx, candidateType: 'supplier_invoice', candidateId: foreign,
  });

  expect(status).toBe(404);
  expect(await counts(bankTx)).toMatchObject({ payments: 0 });
  expect(Number((await billRow(foreign)).amount_paid)).toBe(0);
});

it('refuses a money-IN line against a bill before any write', async () => {
  const bill = await seedBill(pool, fx, 1150);
  const bankTx = await seedBankLine(pool, fx, 1150);
  const before = await counts(bankTx);

  const { status, committed } = await confirmMatch(pool, fx, {
    bankTransactionId: bankTx, candidateType: 'supplier_invoice', candidateId: bill,
  });

  // A pre-write refusal keeps its 4xx and still COMMITs — nothing was written.
  expect(status).toBe(400);
  expect(committed).toBe(true);
  expect(await counts(bankTx)).toEqual({ payments: 0, journals: before.journals });
  expect(Number((await billRow(bill)).amount_paid)).toBe(0);
});

it('refuses a bill that is already fully paid', async () => {
  const bill = await seedBill(pool, fx, 500);
  await pool.query("UPDATE supplier_invoices SET amount_paid=500, status='paid' WHERE id=$1", [bill]);
  const bankTx = await seedBankLine(pool, fx, -500);

  const { status, body } = await confirmMatch(pool, fx, {
    bankTransactionId: bankTx, candidateType: 'supplier_invoice', candidateId: bill,
  });

  // Nothing is left to settle, so there is no positive allocation to make.
  expect(status).toBe(400);
  expect(JSON.stringify(body)).toMatch(/already fully paid/i);
  expect(await counts(bankTx)).toMatchObject({ payments: 0 });
});

/**
 * The contended line, with two REAL interleaved clients — not asserted from
 * reading the code. A holder takes the row's `FOR UPDATE` and keeps it while
 * the route runs on its own connection: the route's validation is all reads and
 * sails past, then `allocateTransaction`'s first statement blocks on the same
 * row and gives up at the 5s `lock_timeout`.
 *
 * 409, not 500. Nothing was acquired so nothing was written, and the answer the
 * user needs is "retry" — which `apiResponse.internalError` would have replaced
 * with "An internal error occurred" outside development.
 */
it('answers 409 with the retry wording when another request holds the line', async () => {
  const bill = await seedBill(pool, fx, 650);
  const bankTx = await seedBankLine(pool, fx, -650);
  const before = await counts(bankTx);

  const holder = await pool.connect();
  let status: number; let body: unknown; let committed: boolean;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM bank_transactions WHERE id=$1 FOR UPDATE', [bankTx]);
    ({ status, body, committed } = await confirmMatch(pool, fx, {
      bankTransactionId: bankTx, candidateType: 'supplier_invoice', candidateId: bill,
    }));
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }

  expect(status).toBe(409);
  expect(JSON.stringify(body)).toMatch(/retry/i);
  expect(JSON.stringify(body)).not.toMatch(/An internal error occurred/);
  // A 4xx COMMITs under withAuth. That is only safe because the lock was never
  // taken: the transaction it commits is empty.
  expect(committed).toBe(true);
  expect(await counts(bankTx)).toEqual({ payments: 0, journals: before.journals });
  expect(Number((await billRow(bill)).amount_paid)).toBe(0);
  const { rows } = await pool.query('SELECT status FROM bank_transactions WHERE id=$1', [bankTx]);
  expect(rows[0].status).toBe('imported');
}, 30_000);
