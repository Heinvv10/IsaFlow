/**
 * K-074 — bank-match-confirm's supplier branch, end to end on real SQL.
 *
 * Two defects, one branch. The UPDATE assigned `supplier_invoices.balance`, a
 * GENERATED ALWAYS column since migration 201, so Postgres refused it (428C9)
 * and the branch never reached its own subledger write. And the catch-all
 * answered 400, which `withAuth` COMMITs, so a throw after `allocateTransaction`
 * had posted the journal committed a half-finished match.
 *
 * Dropping the `balance` assignment alone would have switched ON a BARE
 * `amount_paid` write — no `supplier_payments` row, no `payment_allocations`
 * row. `bankAllocationUnwind` finds its work through exactly those two tables,
 * so the settlement would have been irreversible, and a line larger than the
 * bill would have moved AP by the whole line while the subledger took only the
 * outstanding balance. The branch therefore settles through
 * `applyBankLineToSupplierInvoices`, the way every other AP settlement path
 * does.
 *
 * Only the request wrappers are stubbed. The route posts a real journal through
 * `allocateTransaction`, writes a real payment document and applies it, against
 * the production schema on the disposable fixture.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  cleanupK074, confirmMatch, seedBankLine, seedBill, seedK074, type K074Fixture,
} from './helpers/k074Fixture';


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

async function billRow(id: string) {
  const { rows } = await pool.query(
    'SELECT amount_paid, balance, status FROM supplier_invoices WHERE id=$1', [id],
  );
  return rows[0];
}

/** The payment document this bank line produced, with what it applied. */
async function paymentFor(bankTxId: string) {
  const { rows } = await pool.query(
    `SELECT sp.id, sp.total_amount, sp.status, sp.gl_journal_entry_id,
            COALESCE((SELECT SUM(pa.amount_allocated) FROM payment_allocations pa
                      WHERE pa.payment_id = sp.id), 0) AS allocated
     FROM supplier_payments sp WHERE sp.reference = $1`, [bankTxId],
  );
  return rows[0];
}

/**
 * Debits and credits on one account WITHIN one journal. The journal filter is
 * not decoration: without it the sums cover every journal the fixture company
 * has ever posted, so the assertion would hold only while this test happens to
 * run first.
 */
async function leg(accountId: string, journalEntryId: string) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(debit),0)::float8 AS dr, COALESCE(SUM(credit),0)::float8 AS cr
     FROM gl_journal_lines WHERE gl_account_id = $1 AND journal_entry_id = $2`,
    [accountId, journalEntryId],
  );
  return rows[0] as { dr: number; cr: number };
}

it('settles the bill with a payment document, and the journal balances', async () => {
  const bill = await seedBill(pool, fx, 1150);
  const bankTx = await seedBankLine(pool, fx, -1150);

  const { status, committed } = await confirmMatch(pool, fx, {
    bankTransactionId: bankTx, candidateType: 'supplier_invoice', candidateId: bill,
  });
  expect(status).toBe(200);
  expect(committed).toBe(true);

  const row = await billRow(bill);
  expect(Number(row.amount_paid)).toBe(1150);
  // The generated column follows amount_paid; the route must not assign it.
  expect(Number(row.balance)).toBe(0);
  expect(row.status).toBe('paid');

  // HIGH-1: the document without which the settlement cannot be reversed.
  const payment = await paymentFor(bankTx);
  expect(payment).toBeDefined();
  expect(Number(payment.total_amount)).toBe(1150);
  expect(Number(payment.allocated)).toBe(1150);
  expect(payment.gl_journal_entry_id).toBeTruthy();

  // The journal itself: balanced, and AP relieved by exactly the cash.
  const { rows: je } = await pool.query(
    `SELECT COALESCE(SUM(debit),0)::float8 AS dr, COALESCE(SUM(credit),0)::float8 AS cr
     FROM gl_journal_lines WHERE journal_entry_id = $1`, [payment.gl_journal_entry_id],
  );
  expect(je[0].dr).toBeCloseTo(je[0].cr, 2);
  const je_id = String(payment.gl_journal_entry_id);
  expect((await leg(fx.apAccount, je_id)).dr).toBeCloseTo(1150, 2);
  expect((await leg(fx.bankAccount, je_id)).cr).toBeCloseTo(1150, 2);
});

it('unallocating the line reverses the subledger, not just the GL', async () => {
  const bill = await seedBill(pool, fx, 500);
  const bankTx = await seedBankLine(pool, fx, -500);
  await confirmMatch(pool, fx, {
    bankTransactionId: bankTx, candidateType: 'supplier_invoice', candidateId: bill,
  });
  expect(Number((await billRow(bill)).amount_paid)).toBe(500);

  // THE POINT OF HIGH-1. unwindBankAllocationApplication starts from the
  // journal and finds the payment by gl_journal_entry_id, then reverses
  // amount_paid from payment_allocations. A bare amount_paid write leaves both
  // lookups empty, so the GL reverses and the bill stays paid forever.
  const payment = await paymentFor(bankTx);
  const { als } = await import('@/lib/als');
  const { unwindBankAllocationApplication } = await import(
    '@/modules/accounting/services/bank/bankAllocationUnwind'
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await als.run(
      { client, userId: fx.user, companyId: fx.company, claims: {} },
      () => unwindBankAllocationApplication(fx.company, String(payment.gl_journal_entry_id)),
    );
    await client.query('COMMIT');
    expect(result.paymentsCancelled).toBe(1);
    expect(result.amountUnapplied).toBeCloseTo(500, 2);
  } finally { client.release(); }

  const after = await billRow(bill);
  expect(Number(after.amount_paid)).toBe(0);
  expect(Number(after.balance)).toBe(500);
  expect(after.status).not.toBe('paid');
});

it('settles a partial payment and leaves the generated balance consistent', async () => {
  const bill = await seedBill(pool, fx, 1150);
  const bankTx = await seedBankLine(pool, fx, -400);

  const { status } = await confirmMatch(pool, fx, {
    bankTransactionId: bankTx, candidateType: 'supplier_invoice', candidateId: bill,
  });
  expect(status).toBe(200);

  const row = await billRow(bill);
  expect(Number(row.amount_paid)).toBe(400);
  expect(Number(row.balance)).toBe(750);
  expect(row.status).toBe('partially_paid');
  expect(Number((await paymentFor(bankTx)).allocated)).toBe(400);
});

it('refuses an over-payment rather than leaving a credit the AP aging cannot see', async () => {
  const bill = await seedBill(pool, fx, 600);
  const bankTx = await seedBankLine(pool, fx, -1000);

  const { status, body, committed } = await confirmMatch(pool, fx, {
    bankTransactionId: bankTx, candidateType: 'supplier_invoice', candidateId: bill,
  });

  // allocateTransaction would relieve AP control by the whole R1,000 while the
  // bill can only take R600, and apAgingService reads supplier_invoices alone —
  // so the R400 would part the control account from the aging with nothing on
  // any AP report to explain it. Refused BEFORE the first write, naming the
  // excess and the remedy.
  expect(status).toBe(400);
  expect(committed).toBe(true);
  expect(JSON.stringify(body)).toMatch(/R400\.00 excess/);
  expect(JSON.stringify(body)).toMatch(/split the line/i);

  const row = await billRow(bill);
  expect(Number(row.amount_paid)).toBe(0);
  expect(row.status).toBe('approved');
  expect(await paymentFor(bankTx)).toBeUndefined();
  const { rowCount } = await pool.query(
    'SELECT id FROM gl_journal_entries WHERE company_id=$1 AND description LIKE $2',
    [fx.company, '%' + bankTx + '%'],
  );
  expect(rowCount).toBe(0);
});

it('names the payment document it created in the response', async () => {
  const bill = await seedBill(pool, fx, 250);
  const bankTx = await seedBankLine(pool, fx, -250);

  const { status, body } = await confirmMatch(pool, fx, {
    bankTransactionId: bankTx, candidateType: 'supplier_invoice', candidateId: bill,
  });

  // The screen's only channel. A confirm that settles a bill says which
  // document did it, so the user can find the cash from the bill and back.
  expect(status).toBe(200);
  const payload = (body as { data?: Record<string, unknown> }).data ?? body as Record<string, unknown>;
  expect(payload.supplierPaymentId).toBe(String((await paymentFor(bankTx)).id));
  expect(payload.allocated).toBe(250);
});
