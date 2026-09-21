/**
 * K-074 (round-5 MEDIUM-1) — bank-match-confirm's CUSTOMER branch, end to end
 * on real SQL. The mirror of the supplier file beside it, and the same defect.
 *
 * The branch posted the journal through `allocateTransaction(… 'customer',
 * { autoApply: false })` and then wrote `customer_invoices.amount_paid`
 * ABSOLUTELY, with no `customer_payment_allocations` row behind it.
 * `bankAllocationUnwind` reverses an application from exactly that table, so a
 * reversal returned the credit to the AR control account and left the invoice
 * reading as paid — the control-to-subledger gap this programme exists to find,
 * behind an ordinary-looking contra. The JS-computed absolute value was also a
 * lost update over any concurrent settlement.
 *
 * The branch now settles through `confirmReceiptMatch`, so the receipt document
 * and its allocation exist and the reversal is exact. Only the request wrappers
 * are stubbed; the journal, the document and the application are real.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  cleanupK074, confirmMatch, seedBankLine, seedInvoice, seedK074, type K074Fixture,
} from './helpers/k074Fixture';

// The handler is the default export, so the wrappers come with it. withAuth's
// transaction is what `confirmMatch` reimplements (it must decide COMMIT vs
// ROLLBACK itself to observe the status-code rule).
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

async function invoiceRow(id: string) {
  const { rows } = await pool.query(
    'SELECT amount_paid, status, paid_at FROM customer_invoices WHERE id=$1', [id],
  );
  return rows[0];
}

/**
 * The receipt document this bank line produced, with what it applied.
 *
 * Reached through the line's OWN journal — `matched_journal_line_id` is the bank
 * leg this allocation posted, and `customer_payments.gl_journal_entry_id` names
 * the same entry. `bank_reference` is not an identifier here: allocateTransaction
 * copies the statement description into it, which every fixture line shares.
 */
async function receiptFor(bankTxId: string) {
  const { rows } = await pool.query(
    `SELECT cp.id, cp.total_amount, cp.status, cp.gl_journal_entry_id,
            COALESCE((SELECT SUM(cpa.amount_allocated) FROM customer_payment_allocations cpa
                      WHERE cpa.payment_id = cp.id), 0) AS allocated
     FROM customer_payments cp
     WHERE cp.company_id = $2
       AND cp.gl_journal_entry_id = (
         SELECT jl.journal_entry_id FROM gl_journal_lines jl
         JOIN bank_transactions bt ON bt.matched_journal_line_id = jl.id
         WHERE bt.id = $1 AND bt.company_id = $2)`,
    [bankTxId, fx.company],
  );
  return rows[0];
}

/**
 * Journal LINES on the AR control account, for the whole company. A delta of
 * zero across a request is the only honest way to say "no journal was posted":
 * the journal's description names the customer, never the bank line, so a LIKE
 * on the bank-tx id matches nothing whether or not one was written.
 */
async function arLineCount(): Promise<number> {
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM gl_journal_lines WHERE company_id=$1 AND gl_account_id=$2',
    [fx.company, fx.arAccount],
  );
  return rows[0].n as number;
}

/** Debits and credits on one account WITHIN one journal. */
async function leg(accountId: string, journalEntryId: string) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(debit),0)::float8 AS dr, COALESCE(SUM(credit),0)::float8 AS cr
     FROM gl_journal_lines WHERE gl_account_id = $1 AND journal_entry_id = $2`,
    [accountId, journalEntryId],
  );
  return rows[0] as { dr: number; cr: number };
}

it('settles the invoice with a receipt document, and the journal balances', async () => {
  const invoice = await seedInvoice(pool, fx, 1150);
  const bankTx = await seedBankLine(pool, fx, 1150);

  const { status, committed } = await confirmMatch(pool, fx, {
    bankTransactionId: bankTx, candidateType: 'customer_invoice', candidateId: invoice,
  });
  expect(status).toBe(200);
  expect(committed).toBe(true);

  const row = await invoiceRow(invoice);
  expect(Number(row.amount_paid)).toBe(1150);
  expect(row.status).toBe('paid');
  // `paid_at` is derived by recomputeInvoiceStatus from the same threshold; the
  // branch this replaces set it inline from a JS `new Date()`.
  expect(row.paid_at).toBeTruthy();

  // THE FIX: the allocation row without which the settlement cannot be reversed.
  const receipt = await receiptFor(bankTx);
  expect(receipt).toBeDefined();
  expect(Number(receipt.total_amount)).toBe(1150);
  expect(Number(receipt.allocated)).toBe(1150);
  expect(receipt.gl_journal_entry_id).toBeTruthy();

  // The journal itself: balanced, and AR relieved by exactly the cash.
  const je_id = String(receipt.gl_journal_entry_id);
  const { rows: je } = await pool.query(
    `SELECT COALESCE(SUM(debit),0)::float8 AS dr, COALESCE(SUM(credit),0)::float8 AS cr
     FROM gl_journal_lines WHERE journal_entry_id = $1`, [je_id],
  );
  expect(je[0].dr).toBeCloseTo(je[0].cr, 2);
  expect((await leg(fx.arAccount, je_id)).cr).toBeCloseTo(1150, 2);
  expect((await leg(fx.bankAccount, je_id)).dr).toBeCloseTo(1150, 2);
});

it('unallocating the line reverses the subledger, not just the GL', async () => {
  const invoice = await seedInvoice(pool, fx, 500);
  const bankTx = await seedBankLine(pool, fx, 500);
  await confirmMatch(pool, fx, {
    bankTransactionId: bankTx, candidateType: 'customer_invoice', candidateId: invoice,
  });
  expect(Number((await invoiceRow(invoice)).amount_paid)).toBe(500);

  // THE POINT OF MEDIUM-1. unwindBankAllocationApplication starts from the
  // journal, finds the receipt by gl_journal_entry_id and reverses amount_paid
  // from customer_payment_allocations. The bare amount_paid write left both
  // lookups empty: the GL reversed and the invoice stayed paid forever.
  const receipt = await receiptFor(bankTx);
  const { als } = await import('@/lib/als');
  const { unwindBankAllocationApplication } = await import(
    '@/modules/accounting/services/bank/bankAllocationUnwind'
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await als.run(
      { client, userId: fx.user, companyId: fx.company, claims: {} },
      () => unwindBankAllocationApplication(fx.company, String(receipt.gl_journal_entry_id)),
    );
    await client.query('COMMIT');
    expect(result.paymentsCancelled).toBe(1);
    expect(result.invoicesReopened).toBe(1);
    expect(result.amountUnapplied).toBeCloseTo(500, 2);
  } finally { client.release(); }

  const after = await invoiceRow(invoice);
  expect(Number(after.amount_paid)).toBe(0);
  expect(after.status).not.toBe('paid');
  expect(after.paid_at).toBeNull();
});

it('settles a partial receipt for exactly the line', async () => {
  const invoice = await seedInvoice(pool, fx, 1150);
  const bankTx = await seedBankLine(pool, fx, 400);

  const { status } = await confirmMatch(pool, fx, {
    bankTransactionId: bankTx, candidateType: 'customer_invoice', candidateId: invoice,
  });
  expect(status).toBe(200);

  const row = await invoiceRow(invoice);
  expect(Number(row.amount_paid)).toBe(400);
  expect(row.status).toBe('partially_paid');
  expect(Number((await receiptFor(bankTx)).allocated)).toBe(400);
});

it('refuses an over-receipt rather than leaving cash the debtors aging cannot see', async () => {
  const invoice = await seedInvoice(pool, fx, 600);
  const bankTx = await seedBankLine(pool, fx, 1000);
  const arLinesBefore = await arLineCount();

  const { status, body, committed } = await confirmMatch(pool, fx, {
    bankTransactionId: bankTx, candidateType: 'customer_invoice', candidateId: invoice,
  });

  // The branch this replaces CAPPED at min(line, outstanding) and left the R400
  // on the AR control account with no allocation naming it. `debtorsManager`
  // builds the aging from `customer_invoices` alone, so control and aging would
  // part by the excess. Refused BEFORE the first write, naming the excess.
  expect(status).toBe(400);
  expect(committed).toBe(true);
  expect(JSON.stringify(body)).toMatch(/R400\.00 excess/);
  expect(JSON.stringify(body)).toMatch(/split the line/i);

  const row = await invoiceRow(invoice);
  expect(Number(row.amount_paid)).toBe(0);
  expect(row.status).toBe('approved');
  expect(await receiptFor(bankTx)).toBeUndefined();
  expect(await arLineCount()).toBe(arLinesBefore);
});

it('refuses an invoice in another tenant without touching it', async () => {
  const foreign = await seedInvoice(pool, fx, 900, { companyId: fx.otherCompany });
  const bankTx = await seedBankLine(pool, fx, 900);
  const arLinesBefore = await arLineCount();

  const { status } = await confirmMatch(pool, fx, {
    bankTransactionId: bankTx, candidateType: 'customer_invoice', candidateId: foreign,
  });

  expect(status).toBe(404);
  expect(Number((await invoiceRow(foreign)).amount_paid)).toBe(0);
  expect(await receiptFor(bankTx)).toBeUndefined();
  expect(await arLineCount()).toBe(arLinesBefore);
});

it('refuses a cancelled invoice, and writes nothing', async () => {
  const invoice = await seedInvoice(pool, fx, 900, { status: 'cancelled' });
  const bankTx = await seedBankLine(pool, fx, 900);
  const arLinesBefore = await arLineCount();

  const { status, body } = await confirmMatch(pool, fx, {
    bankTransactionId: bankTx, candidateType: 'customer_invoice', candidateId: invoice,
  });

  // The inline UPDATE carried no status filter and would have stamped this
  // invoice 'paid'. The settlement path refuses it from a read instead.
  expect(status).toBe(400);
  expect(JSON.stringify(body)).toMatch(/cancelled/i);
  expect((await invoiceRow(invoice)).status).toBe('cancelled');
  expect(Number((await invoiceRow(invoice)).amount_paid)).toBe(0);
  expect(await arLineCount()).toBe(arLinesBefore);
});

it('refuses an invoice that is already fully paid', async () => {
  const invoice = await seedInvoice(pool, fx, 500);
  await pool.query("UPDATE customer_invoices SET amount_paid=500, status='paid' WHERE id=$1", [invoice]);
  const bankTx = await seedBankLine(pool, fx, 500);

  const { status, body } = await confirmMatch(pool, fx, {
    bankTransactionId: bankTx, candidateType: 'customer_invoice', candidateId: invoice,
  });

  expect(status).toBe(400);
  expect(JSON.stringify(body)).toMatch(/already fully paid/i);
  expect(await receiptFor(bankTx)).toBeUndefined();
});

it('refuses an already-allocated line with the reason, not a bare 500', async () => {
  const invoice = await seedInvoice(pool, fx, 700);
  const bankTx = await seedBankLine(pool, fx, 700);
  await pool.query("UPDATE bank_transactions SET status='allocated' WHERE id=$1", [bankTx]);

  const { status, body } = await confirmMatch(pool, fx, {
    bankTransactionId: bankTx, candidateType: 'customer_invoice', candidateId: invoice,
  });

  expect(status).toBe(400);
  expect(JSON.stringify(body)).toMatch(/cannot be allocated/i);
  expect(Number((await invoiceRow(invoice)).amount_paid)).toBe(0);
  expect(await receiptFor(bankTx)).toBeUndefined();
});

/**
 * The contended line, with two REAL interleaved clients. A holder takes the
 * row's `FOR UPDATE` and keeps it while the route runs on its own connection:
 * the customer arm's validation is all reads and sails past, then
 * `allocateTransaction` — two frames below `confirmReceiptMatch` — blocks on the
 * same row and gives up at the 5s `lock_timeout`. 409, not 500: nothing was
 * acquired, so nothing was written.
 */
it('answers 409 when another request holds the line', async () => {
  const invoice = await seedInvoice(pool, fx, 650);
  const bankTx = await seedBankLine(pool, fx, 650);
  const arLinesBefore = await arLineCount();

  const holder = await pool.connect();
  let status: number; let body: unknown; let committed: boolean;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM bank_transactions WHERE id=$1 FOR UPDATE', [bankTx]);
    ({ status, body, committed } = await confirmMatch(pool, fx, {
      bankTransactionId: bankTx, candidateType: 'customer_invoice', candidateId: invoice,
    }));
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }

  expect(status).toBe(409);
  expect(JSON.stringify(body)).toMatch(/retry/i);
  expect(committed).toBe(true);
  expect(await arLineCount()).toBe(arLinesBefore);
  expect(Number((await invoiceRow(invoice)).amount_paid)).toBe(0);
  const { rows } = await pool.query('SELECT status FROM bank_transactions WHERE id=$1', [bankTx]);
  expect(rows[0].status).toBe('imported');
}, 30_000);

it('names the receipt document it created in the response', async () => {
  const invoice = await seedInvoice(pool, fx, 250);
  const bankTx = await seedBankLine(pool, fx, 250);

  const { status, body } = await confirmMatch(pool, fx, {
    bankTransactionId: bankTx, candidateType: 'customer_invoice', candidateId: invoice,
  });

  expect(status).toBe(200);
  const payload = (body as { data?: Record<string, unknown> }).data ?? body as Record<string, unknown>;
  expect(payload.customerPaymentId).toBe(String((await receiptFor(bankTx)).id));
  expect(payload.allocated).toBe(250);
});
