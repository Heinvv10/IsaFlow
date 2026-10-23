// Shared fixture for the K-021 reversal-atomicity suites:
//   k021-reversal-atomicity.int.test.ts         the savepoint, success, retry, tenant, OUT chain
//   k021-reversal-atomicity-periods.int.test.ts the fallback-date period cases
// Each suite builds its own tenant (two companies, two admins, a closed old
// period, an open current one, a bank and an AR control account) with
// `k021World`, so neither depends on the other's rows or run order.
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import action from '../../pages/api/accounting/bank-transactions-action';
import { request, response } from './mfa-impersonation-postgres.helpers';

/** One self-contained receipt: invoice, posted cash journal, payment, bank line. */
export interface Fixture {
  je: string; bankLine: string; arLine: string; invoice: string; payment: string; bankTx: string;
}
export const newFixture = (): Fixture => ({
  je: crypto.randomUUID(), bankLine: crypto.randomUUID(), arLine: crypto.randomUUID(),
  invoice: crypto.randomUUID(), payment: crypto.randomUUID(), bankTx: crypto.randomUUID(),
});

// Today's period is OPEN here — the opposite of the RED fixture. The original
// entry sits in a CLOSED earlier period, so resolveReversalDate falls back to
// today and the pre-flight passes: failures below come from the contra itself.
//
// The old period is derived from today rather than hard-coded. A fixed month
// would collide with the current one when the suite runs in that month, and
// getPeriodStatusForDate's `SELECT status … LIMIT 1` has no ORDER BY — which of
// the two overlapping rows wins would be heap order. Fourteen months back can
// never be the current month.
const today = new Date();
const monthStart = new Date(Date.UTC(today.getFullYear(), today.getMonth(), 1)).toISOString().slice(0, 10);
const monthEnd = new Date(Date.UTC(today.getFullYear(), today.getMonth() + 1, 0)).toISOString().slice(0, 10);
const old = new Date(Date.UTC(today.getFullYear(), today.getMonth() - 14, 10));
export const oldDate = old.toISOString().slice(0, 10);
const oldStart = new Date(Date.UTC(old.getUTCFullYear(), old.getUTCMonth(), 1)).toISOString().slice(0, 10);
const oldEnd = new Date(Date.UTC(old.getUTCFullYear(), old.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
// Somewhere earlier still, and clear of both: where the current period is
// PARKED once a test needs today to be uncovered.
const parked = new Date(Date.UTC(today.getFullYear(), today.getMonth() - 25, 1));
export const parkedStart = parked.toISOString().slice(0, 10);
export const parkedEnd = new Date(Date.UTC(parked.getUTCFullYear(), parked.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);

export const UNTOUCHED = {
  bankTxStatus: 'allocated',
  invoiceAmountPaid: 1000,
  invoiceStatus: 'paid',
  paymentStatus: 'reconciled',
  allocationRows: 1,
  reversalJournals: 0,
};

/** A fresh tenant and its helpers; `seed()` in beforeAll, `teardown()` in afterAll. */
export function k021World(pool: Pool) {
  const company = crypto.randomUUID();
  const otherCompany = crypto.randomUUID();
  const user = crypto.randomUUID();
  const otherUser = crypto.randomUUID();
  const bank = crypto.randomUUID();
  const arControl = crypto.randomUUID();
  const oldPeriod = crypto.randomUUID();
  const nowPeriod = crypto.randomUUID();
  const customer = crypto.randomUUID();
  const tokens = { token: '', otherToken: '' };

  async function seedFixture(f: Fixture, label: string): Promise<void> {
    await pool.query(
      `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,subtotal,total_amount,amount_paid,status,created_by)
       VALUES($1,$2,$5,$3,1000,1000,1000,'paid',$4)`,
      [f.invoice, company, customer, user, `K021A-INV-${label}`],
    );
    await pool.query(
      `INSERT INTO gl_journal_entries(id,company_id,entry_date,description,status,created_by,fiscal_period_id,posted_at,posted_by,source)
       VALUES($1,$2,$6::date,$5,'posted',$3,$4,NOW(),$3,'auto_bank_recon')`,
      [f.je, company, user, oldPeriod, `K021A ${label} receipt`, oldDate],
    );
    await pool.query(
      `INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit)
       VALUES($1,$3,$4,$5,1000,0),($2,$3,$4,$6,0,1000)`,
      [f.bankLine, f.arLine, company, f.je, bank, arControl],
    );
    await pool.query(
      `INSERT INTO customer_payments(id,company_id,client_id,payment_date,total_amount,status,gl_journal_entry_id,created_by)
       VALUES($1,$2,$3,$6::date,1000,'reconciled',$4,$5)`,
      [f.payment, company, customer, f.je, user, oldDate],
    );
    await pool.query(
      'INSERT INTO customer_payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,1000)',
      [f.payment, f.invoice],
    );
    await pool.query(
      `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status,matched_journal_line_id,allocation_type)
       VALUES($1,$2,$3,$6::date,1000,$5,'allocated',$4,'customer')`,
      [f.bankTx, company, bank, f.bankLine, `K021A ${label}`, oldDate],
    );
  }

  /** Everything the unwind touches, read back in one shot. */
  async function readState(f: Fixture) {
    const inv = await pool.query('SELECT amount_paid, status FROM customer_invoices WHERE id=$1', [f.invoice]);
    const pay = await pool.query('SELECT status FROM customer_payments WHERE id=$1', [f.payment]);
    const allocs = await pool.query('SELECT COUNT(*)::int AS n FROM customer_payment_allocations WHERE payment_id=$1', [f.payment]);
    const tx = await pool.query('SELECT status FROM bank_transactions WHERE id=$1', [f.bankTx]);
    const rev = await pool.query(
      'SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND reversal_of_id=$2', [company, f.je]);
    return {
      bankTxStatus: tx.rows[0].status,
      invoiceAmountPaid: Number(inv.rows[0].amount_paid),
      invoiceStatus: inv.rows[0].status,
      paymentStatus: pay.rows[0].status,
      allocationRows: allocs.rows[0].n,
      reversalJournals: rev.rows[0].n,
    };
  }

  async function reverse(bankTxId: string, jwt: string, asCompany: string) {
    const req = request({ 'sb-access-token': jwt, active_company_id: asCompany }, 'POST');
    req.url = '/api/accounting/bank-transactions-action';
    req.body = { action: 'reverse', bankTransactionId: bankTxId };
    const result = response();
    await action(req, result.res);
    return result;
  }

  /** The tenant, then each fixture under its label, then both admins' tokens. */
  async function seed(fixtures: Array<[Fixture, string]>): Promise<void> {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
      [company, 'K021A owner', otherCompany, 'K021A outsider']);
    await pool.query(
      "INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true),($3,$4,'admin',true)",
      [user, `${user}@test.local`, otherUser, `${otherUser}@test.local`]);
    await pool.query(
      "INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin'),($3,$4,'admin')",
      [company, user, otherCompany, otherUser]);
    await pool.query(
      `INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
       VALUES($1,$3,'K021A old',2,2098,$6::date,$7::date,'closed'),
             ($2,$3,'K021A current',1,2099,$4::date,$5::date,'open')`,
      [oldPeriod, nowPeriod, company, monthStart, monthEnd, oldStart, oldEnd],
    );
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance)
       VALUES($1,$3,'K021AB','K021A Bank','asset','bank','debit'),($2,$3,'K021AAR','K021A AR control','asset',NULL,'debit')`,
      [bank, arControl, company],
    );
    await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'K021A customer']);

    for (const [f, label] of fixtures) await seedFixture(f, label);

    for (const jwt of [{ id: user, set: (t: string) => { tokens.token = t; } }, { id: otherUser, set: (t: string) => { tokens.otherToken = t; } }]) {
      jwt.set(await new SignJWT({ sub: jwt.id, aal: 'aal2' })
        .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
        .sign(new TextEncoder().encode(process.env.JWT_SECRET)));
    }
  }

  async function teardown(fixtures: Fixture[]): Promise<void> {
    try {
      for (const f of fixtures) {
        await pool.query('DELETE FROM customer_payment_allocations WHERE payment_id=$1', [f.payment]);
      }
      await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM customer_payments WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM customers WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
      await pool.query('UPDATE gl_journal_entries SET reversal_of_id = NULL WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id=ANY($1::uuid[])', [[bank, arControl]]);
      await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM company_users WHERE company_id=ANY($1::uuid[])', [[company, otherCompany]]);
      await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [[company, otherCompany]]);
      await pool.query('DELETE FROM users WHERE id=ANY($1::text[])', [[user, otherUser]]);
    } finally {
      await pool.end();
    }
  }

  return {
    company, otherCompany, user, bank, arControl, oldPeriod, nowPeriod, tokens,
    seed, readState, reverse, teardown,
  };
}
