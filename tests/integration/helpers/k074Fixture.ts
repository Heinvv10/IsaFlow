/**
 * Fixture for the bank-match-confirm supplier-branch tests (audit K-074).
 *
 * The branch settles a bill through the REAL posting path — allocateTransaction
 * posts the journal, supplierBankPaymentService writes the payment document and
 * applies it — so the fixture seeds everything that path reads: a chart of
 * accounts with an AP control and a bank account, an OPEN fiscal period
 * covering the line's date, a supplier, a bill and an unallocated bank line.
 */
import type { Pool } from 'pg';
import type { NextApiRequest } from 'next';
import { response } from '../mfa-impersonation-postgres.helpers';

/** Every date in these tests. The seeded fiscal period covers it. */
export const DAY = '2026-05-15';

export interface K074Fixture {
  company: string;
  otherCompany: string;
  user: string;
  supplier: string;
  customer: string;
  bankAccount: string;
  apAccount: string;
  arAccount: string;
}

let seq = 0;
function code(prefix: string): string {
  seq += 1;
  return `${prefix}${String(seq).padStart(3, '0')}`;
}

async function account(
  pool: Pool, companyId: string, accountCode: string, name: string,
  type: string, subtype: string, normal: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,
       account_subtype,normal_balance,is_active,is_system_account)
     VALUES($1,$2,$3,$4,$5,$6,$7,true,true)`,
    [id, companyId, accountCode, name, type, subtype, normal],
  );
  return id;
}

export async function seedK074(pool: Pool): Promise<K074Fixture> {
  const company = crypto.randomUUID();
  const otherCompany = crypto.randomUUID();
  const user = crypto.randomUUID();
  const supplier = crypto.randomUUID();
  const customer = crypto.randomUUID();

  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)",
    [user, `${user}@test.local`]);
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K074 company']);
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [otherCompany, 'K074 other']);
  await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3)',
    [supplier, company, 'K074 supplier']);
  // `auto_allocate_strategy` stays 'off': the customer arm names the invoice it
  // settles, and a strategy running beside it would apply the same receipt
  // twice. The default is 'off', asserted here rather than assumed.
  await pool.query("INSERT INTO customers(id,company_id,name,auto_allocate_strategy) VALUES($1,$2,$3,'off')",
    [customer, company, 'K074 customer']);

  const bankAccount = await account(pool, company, code('K74B'), 'K074 Bank', 'asset', 'bank', 'debit');
  const apAccount = await account(pool, company, code('K74P'), 'K074 Accounts Payable',
    'liability', 'payable', 'credit');
  const arAccount = await account(pool, company, code('K74R'), 'K074 Accounts Receivable',
    'asset', 'receivable', 'debit');
  await account(pool, company, code('K74E'), 'K074 Expense', 'expense', 'default_expense', 'debit');

  // The route refuses a line whose date no OPEN period covers, from a read.
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,
       start_date,end_date,status)
     VALUES($1,'K074 FY2026 P05',5,2026,'2026-05-01','2026-05-31','open')`,
    [company],
  );

  return { company, otherCompany, user, supplier, customer, bankAccount, apAccount, arAccount };
}

/** A bill for `total`, at `status`, owned by `companyId`. */
export async function seedBill(
  pool: Pool, fx: K074Fixture, total: number,
  opts: { companyId?: string; status?: string } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,
       due_date,subtotal,tax_amount,total_amount,amount_paid,status,created_by)
     VALUES($1,$2,$3,$4,$5::DATE - 10,$5::DATE + 20,$6,0,$6,0,$7,$8)`,
    [id, opts.companyId ?? fx.company, fx.supplier, `K074-${id.slice(0, 8)}`, DAY,
      total, opts.status ?? 'approved', fx.user],
  );
  return id;
}

/** A customer invoice for `total`, at `status`, owned by `companyId`. */
export async function seedInvoice(
  pool: Pool, fx: K074Fixture, total: number,
  opts: { companyId?: string; status?: string } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,customer_id,invoice_number,invoice_date,
       due_date,subtotal,tax_amount,total_amount,amount_paid,status,created_by)
     VALUES($1,$2,$3,$4,$5::DATE - 10,$5::DATE + 20,$6,0,$6,0,$7,$8)`,
    [id, opts.companyId ?? fx.company, fx.customer, `K074C-${id.slice(0, 8)}`, DAY,
      total, opts.status ?? 'approved', fx.user],
  );
  return id;
}

/** An unallocated bank line for `amount` (negative = money out). */
export async function seedBankLine(pool: Pool, fx: K074Fixture, amount: number): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,
       description,status)
     VALUES($1,$2,$3,$4::DATE,$5,'K074 payment','imported')`,
    [id, fx.company, fx.bankAccount, DAY, amount],
  );
  return id;
}

/**
 * Run the route the way withAuth runs it: one transaction on the ALS-bound
 * client, COMMIT only when the handler answered below 500 — the very decision
 * this fix turns on.
 */
export async function confirmMatch(
  pool: Pool, fx: K074Fixture,
  body: { bankTransactionId: string; candidateType: string; candidateId: string },
): Promise<{ status: number; body: unknown; committed: boolean }> {
  const { als } = await import('@/lib/als');
  const handler = (await import('../../../pages/api/accounting/bank-match-confirm')).default as
    (req: NextApiRequest, res: unknown) => Promise<unknown>;

  const result = response();
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    await als.run({ client, userId: fx.user, companyId: fx.company, claims: {} }, async () => {
      const req = {
        method: 'POST', body,
        companyId: fx.company, user: { id: fx.user },
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

export async function cleanupK074(pool: Pool, fx: K074Fixture): Promise<void> {
  const ids = [fx.company, fx.otherCompany];
  await pool.query('DELETE FROM customer_payment_allocations WHERE payment_id IN (SELECT id FROM customer_payments WHERE company_id=ANY($1::UUID[]))', [ids]);
  await pool.query('DELETE FROM customer_payments WHERE company_id=ANY($1::UUID[])', [ids]);
  await pool.query('DELETE FROM customer_invoices WHERE company_id=ANY($1::UUID[])', [ids]);
  await pool.query('DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM supplier_payments WHERE company_id=ANY($1::UUID[]))', [ids]);
  await pool.query('DELETE FROM supplier_payments WHERE company_id=ANY($1::UUID[])', [ids]);
  await pool.query('DELETE FROM bank_transactions WHERE company_id=ANY($1::UUID[])', [ids]);
  await pool.query('DELETE FROM supplier_invoices WHERE company_id=ANY($1::UUID[])', [ids]);
  await pool.query('DELETE FROM gl_journal_lines WHERE company_id=ANY($1::UUID[])', [ids]);
  await pool.query('DELETE FROM gl_journal_entries WHERE company_id=ANY($1::UUID[])', [ids]);
  await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=ANY($1::UUID[]))', [ids]);
  await pool.query('DELETE FROM gl_accounts WHERE company_id=ANY($1::UUID[])', [ids]);
  await pool.query('DELETE FROM fiscal_periods WHERE company_id=ANY($1::UUID[])', [ids]);
  await pool.query('DELETE FROM suppliers WHERE company_id=ANY($1::UUID[])', [ids]);
  await pool.query('DELETE FROM customers WHERE company_id=ANY($1::UUID[])', [ids]);
  await pool.query('DELETE FROM companies WHERE id=ANY($1::UUID[])', [ids]);
  await pool.query('DELETE FROM users WHERE id=$1', [fx.user]);
}
