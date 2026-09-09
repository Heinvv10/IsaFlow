/**
 * K-074 — bank-match-confirm posts the GL before the subledger update, both
 * under one 400.
 *
 * pages/api/accounting/bank-match-confirm.ts:109 calls allocateTransaction
 * (which posts the journal entry, updates bank_transactions and may write a
 * supplier payment document), and only THEN runs the subledger UPDATE at :119.
 * The route's catch turned any failure of that UPDATE into
 * apiResponse.badRequest — a 400 — and withAuth commits on statusCode < 500,
 * so a post-write failure committed the half-finished match.
 *
 * The trigger is not hypothetical. That UPDATE assigned `balance`, which
 * migration 201 declared GENERATED ALWAYS AS (total_amount - amount_paid)
 * STORED. Postgres refuses the assignment outright (SQLSTATE 428C9), so the
 * supplier_invoice branch of this route could never reach its own subledger
 * write.
 *
 * This test drives the REAL route handler against the production schema on the
 * disposable fixture, inside a request transaction the way withAuth runs it.
 * Only the auth wrappers and the reconciliation service are mocked — the SQL is
 * real, so the generated-column refusal and the status mapping are both under
 * test.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import type { NextApiRequest } from 'next';
import { assertDisposable, response } from './mfa-impersonation-postgres.helpers';

const allocateTransaction = vi.fn(async () => undefined);
const matchTransaction = vi.fn(async () => undefined);

vi.mock('@/lib/auth', () => ({
  withAuth: (fn: unknown) => fn,
  withWriteAccess: (fn: unknown) => fn,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/modules/accounting/services/bank/bankReconciliationService', () => ({
  allocateTransaction: (...args: unknown[]) => allocateTransaction(...(args as [])),
  matchTransaction: (...args: unknown[]) => matchTransaction(...(args as [])),
}));

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const otherCompany = crypto.randomUUID();
const user = crypto.randomUUID();
const supplier = crypto.randomUUID();
const bankAccount = crypto.randomUUID();

/** One bill and the money-out line that settles it, recreated per test. */
let bill: string;
let bankTx: string;

async function seedCompany(companyId: string, label: string) {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [companyId, label]);
}

beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await seedCompany(company, 'K074 company');
  await seedCompany(otherCompany, 'K074 other company');
  await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3)', [supplier, company, 'K074 supplier']);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,account_subtype)
     VALUES($1,$2,'1110','K074 Bank','asset','debit','bank')`,
    [bankAccount, company],
  );
});

beforeEach(async () => {
  bill = crypto.randomUUID();
  bankTx = crypto.randomUUID();
  await pool.query(
    `INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,due_date,
       subtotal,tax_amount,total_amount,amount_paid,status,created_by)
     VALUES($1,$2,$3,$4,CURRENT_DATE - 5,CURRENT_DATE + 25,1000,150,1150,0,'approved',$5)`,
    [bill, company, supplier, `K074-${bill.slice(0, 8)}`, user],
  );
  await pool.query(
    `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description)
     VALUES($1,$2,$3,CURRENT_DATE,-1150,'K074 payment')`,
    [bankTx, company, bankAccount],
  );
});

afterEach(async () => {
  vi.clearAllMocks();
  allocateTransaction.mockImplementation(async () => undefined);
  await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM supplier_invoices WHERE company_id=$1', [company]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM supplier_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM suppliers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1::UUID[])', [[company, otherCompany]]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

/**
 * Runs the route the way withAuth does: one transaction on the ALS-bound
 * client, COMMIT only when the handler answered below 500 — which is the very
 * decision this fix changes.
 */
async function confirm(candidateId: string, candidateType = 'supplier_invoice') {
  const { als } = await import('@/lib/als');
  const handler = (await import('../../pages/api/accounting/bank-match-confirm')).default as
    (req: NextApiRequest, res: unknown) => Promise<unknown>;

  const result = response();
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    await als.run({ client, userId: user, companyId: company, claims: {} }, async () => {
      const req = {
        method: 'POST',
        body: { bankTransactionId: bankTx, candidateType, candidateId },
        companyId: company,
        user: { id: user },
      } as unknown as NextApiRequest;
      await handler(req, result.res);
    });
    if (result.state.statusCode < 500) {
      await client.query('COMMIT');
      committed = true;
    } else {
      await client.query('ROLLBACK');
    }
  } finally {
    client.release();
  }
  return { status: result.state.statusCode, body: result.state.body, committed };
}

async function billRow(id = bill) {
  const { rows } = await pool.query(
    'SELECT amount_paid, balance, status FROM supplier_invoices WHERE id=$1', [id],
  );
  return rows[0];
}

it('records the payment on the bill the way bank-match-confirm writes it', async () => {
  const { status, committed } = await confirm(bill);

  expect(status).toBe(200);
  expect(committed).toBe(true);
  expect(allocateTransaction).toHaveBeenCalledTimes(1);

  const row = await billRow();
  expect(Number(row.amount_paid)).toBe(1150);
  // The generated column follows amount_paid; the route must not assign it.
  expect(Number(row.balance)).toBe(0);
  expect(row.status).toBe('paid');
});

it('settles a partial payment and leaves the generated balance consistent', async () => {
  await pool.query('UPDATE bank_transactions SET amount = -400 WHERE id=$1', [bankTx]);

  const { status, committed } = await confirm(bill);

  expect(status).toBe(200);
  expect(committed).toBe(true);
  const row = await billRow();
  expect(Number(row.amount_paid)).toBe(400);
  expect(Number(row.balance)).toBe(750);
  expect(row.status).toBe('partially_paid');
});

it('answers 500 — not a committing 400 — when the write path throws after the GL post', async () => {
  allocateTransaction.mockImplementationOnce(async () => { throw new Error('journal post failed'); });

  const { status, committed } = await confirm(bill);

  // 500 is what makes withAuth ROLLBACK. A 400 here committed the half-match.
  expect(status).toBe(500);
  expect(committed).toBe(false);
  const row = await billRow();
  expect(Number(row.amount_paid)).toBe(0);
  expect(row.status).toBe('approved');
});

it('refuses a bill belonging to another tenant without touching it', async () => {
  const foreignBill = crypto.randomUUID();
  await pool.query(
    `INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,due_date,
       subtotal,tax_amount,total_amount,amount_paid,status,created_by)
     VALUES($1,$2,$3,'K074-FOREIGN',CURRENT_DATE - 5,CURRENT_DATE + 25,1000,150,1150,0,'approved',$4)`,
    [foreignBill, otherCompany, supplier, user],
  );
  try {
    const { status } = await confirm(foreignBill);
    expect(status).toBe(404);
    expect(allocateTransaction).not.toHaveBeenCalled();
    const row = await billRow(foreignBill);
    expect(Number(row.amount_paid)).toBe(0);
  } finally {
    await pool.query('DELETE FROM supplier_invoices WHERE id=$1', [foreignBill]);
  }
});

it('refuses a money-IN line against a bill before any write', async () => {
  await pool.query('UPDATE bank_transactions SET amount = 1150 WHERE id=$1', [bankTx]);

  const { status, committed } = await confirm(bill);

  // A pre-write refusal keeps its 4xx and still COMMITs — nothing was written.
  expect(status).toBe(400);
  expect(committed).toBe(true);
  expect(allocateTransaction).not.toHaveBeenCalled();
  expect(Number((await billRow()).amount_paid)).toBe(0);
});
