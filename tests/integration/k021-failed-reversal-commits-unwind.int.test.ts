// K-021 RED: reverseReconciledTransaction unwinds the subledger BEFORE posting
// the contra journal. When the contra cannot be posted (the fiscal period
// covering the fallback reversal date is closed), the throw reaches
// bank-transactions-action.ts:178-182, which answers 400 — and withAuth COMMITs
// on any status below 500 (src/lib/auth/withAuth.ts:224-226). The invoice is
// reopened, the receipt cancelled and its allocation rows DELETED, while the
// cash journal stands and the bank line stays 'allocated'.
// Source: src/modules/accounting/services/bank/bankAllocationService.ts:642-648
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import action from '../../pages/api/accounting/bank-transactions-action';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const bank = crypto.randomUUID();
const arControl = crypto.randomUUID();
const oldPeriod = crypto.randomUUID();
const nowPeriod = crypto.randomUUID();
const je = crypto.randomUUID();
const bankLine = crypto.randomUUID();
const arLine = crypto.randomUUID();
const customer = crypto.randomUUID();
const invoice = crypto.randomUUID();
const payment = crypto.randomUUID();
const bankTx = crypto.randomUUID();
let token = '';

// Today's period must exist and be CLOSED: the original period being closed
// makes resolveReversalDate fall back to today (journalEntryPostingService.ts:205).
const today = new Date();
const monthStart = new Date(Date.UTC(today.getFullYear(), today.getMonth(), 1)).toISOString().slice(0, 10);
const monthEnd = new Date(Date.UTC(today.getFullYear(), today.getMonth() + 1, 0)).toISOString().slice(0, 10);

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K021 reversal fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
  await pool.query(
    `INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,$3,'K021 Feb 2026',2,2026,DATE '2026-02-01',DATE '2026-02-28','closed'),
           ($2,$3,'K021 current',1,2099,$4::date,$5::date,'closed')`,
    [oldPeriod, nowPeriod, company, monthStart, monthEnd],
  );
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance)
     VALUES($1,$3,'K021B','K021 Bank','asset','bank','debit'),($2,$3,'K021AR','K021 AR control','asset',NULL,'debit')`,
    [bank, arControl, company],
  );
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'K021 customer']);
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,subtotal,total_amount,amount_paid,status,created_by)
     VALUES($1,$2,'K021-INV-1',$3,1000,1000,1000,'paid',$4)`,
    [invoice, company, customer, user],
  );
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_date,description,status,created_by,fiscal_period_id,posted_at,posted_by,source)
     VALUES($1,$2,DATE '2026-02-10','K021 bank receipt','posted',$3,$4,NOW(),$3,'auto_bank_recon')`,
    [je, company, user, oldPeriod],
  );
  await pool.query(
    `INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit)
     VALUES($1,$3,$4,$5,1000,0),($2,$3,$4,$6,0,1000)`,
    [bankLine, arLine, company, je, bank, arControl],
  );
  await pool.query(
    `INSERT INTO customer_payments(id,company_id,client_id,payment_date,total_amount,status,gl_journal_entry_id,created_by)
     VALUES($1,$2,$3,DATE '2026-02-10',1000,'reconciled',$4,$5)`,
    [payment, company, customer, je, user],
  );
  await pool.query(
    'INSERT INTO customer_payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,1000)',
    [payment, invoice],
  );
  await pool.query(
    `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status,matched_journal_line_id,allocation_type)
     VALUES($1,$2,$3,DATE '2026-02-10',1000,'K021 receipt','allocated',$4,'customer')`,
    [bankTx, company, bank, bankLine],
  );
  token = await new SignJWT({ sub: user, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM customer_payment_allocations WHERE payment_id=$1', [payment]);
    await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customer_payments WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id=ANY($1::uuid[])', [[bank, arControl]]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally {
    await pool.end();
  }
});

describe('K-021 failed bank reversal', () => {
  it('leaves the subledger untouched when the contra journal cannot be posted', async () => {
    const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST');
    req.url = '/api/accounting/bank-transactions-action';
    req.body = { action: 'reverse', bankTransactionId: bankTx };
    const result = response();
    await action(req, result.res);

    const inv = await pool.query('SELECT amount_paid, status FROM customer_invoices WHERE id=$1', [invoice]);
    const pay = await pool.query('SELECT status FROM customer_payments WHERE id=$1', [payment]);
    const allocs = await pool.query('SELECT COUNT(*)::int AS n FROM customer_payment_allocations WHERE payment_id=$1', [payment]);
    const tx = await pool.query('SELECT status, matched_journal_line_id FROM bank_transactions WHERE id=$1', [bankTx]);
    const reversal = await pool.query(
      'SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND reversal_of_id=$2', [company, je]);

    // The reversal did not happen.
    expect(result.state.statusCode).not.toBe(200);
    expect(reversal.rows[0].n).toBe(0);
    // So nothing of the subledger unwind may have survived.
    expect({
      bankTxStatus: tx.rows[0].status,
      invoiceAmountPaid: Number(inv.rows[0].amount_paid),
      invoiceStatus: inv.rows[0].status,
      paymentStatus: pay.rows[0].status,
      allocationRows: allocs.rows[0].n,
    }).toEqual({
      bankTxStatus: 'allocated',
      invoiceAmountPaid: 1000,
      invoiceStatus: 'paid',
      paymentStatus: 'reconciled',
      allocationRows: 1,
    });
  });
});
