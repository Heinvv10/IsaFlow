// K-021 adjacent cases for the atomicity of `reverseReconciledTransaction`.
//
// The RED test (k021-failed-reversal-commits-unwind.int.test.ts) is stopped by
// the pre-flight, so it never reaches the savepoint. These three do:
//   1. a contra that fails for a reason the pre-flight CANNOT see (the original
//      is already reversed) — the savepoint is the only thing that unwinds the
//      unwind;
//   2. the successful reversal, so the fix did not turn a working path into a
//      refusal: balanced contra, and the subledger agrees with it;
//   3. another tenant's reversal of the same bank line, refused with nothing
//      written.
// Every refusal here is a 4xx, which `withAuth` COMMITs — so "nothing written"
// is a claim about the database after the commit, not about an aborted tx.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import action from '../../pages/api/accounting/bank-transactions-action';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const company = crypto.randomUUID();
const otherCompany = crypto.randomUUID();
const user = crypto.randomUUID();
const otherUser = crypto.randomUUID();
const bank = crypto.randomUUID();
const arControl = crypto.randomUUID();
const oldPeriod = crypto.randomUUID();
const nowPeriod = crypto.randomUUID();
const customer = crypto.randomUUID();

/** One self-contained receipt: invoice, posted cash journal, payment, bank line. */
interface Fixture {
  je: string; bankLine: string; arLine: string; invoice: string; payment: string; bankTx: string;
}
const newFixture = (): Fixture => ({
  je: crypto.randomUUID(), bankLine: crypto.randomUUID(), arLine: crypto.randomUUID(),
  invoice: crypto.randomUUID(), payment: crypto.randomUUID(), bankTx: crypto.randomUUID(),
});
const alreadyReversed = newFixture();
const happyPath = newFixture();
const crossTenant = newFixture();
const closedToday = newFixture();
const noPeriodToday = newFixture();
const fixtures = [alreadyReversed, happyPath, crossTenant, closedToday, noPeriodToday];

let token = '';
let otherToken = '';

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
const oldDate = old.toISOString().slice(0, 10);
const oldStart = new Date(Date.UTC(old.getUTCFullYear(), old.getUTCMonth(), 1)).toISOString().slice(0, 10);
const oldEnd = new Date(Date.UTC(old.getUTCFullYear(), old.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
// Somewhere earlier still, and clear of both: where the current period is
// PARKED once a test needs today to be uncovered.
const parked = new Date(Date.UTC(today.getFullYear(), today.getMonth() - 25, 1));
const parkedStart = parked.toISOString().slice(0, 10);
const parkedEnd = new Date(Date.UTC(parked.getUTCFullYear(), parked.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);

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

const UNTOUCHED = {
  bankTxStatus: 'allocated',
  invoiceAmountPaid: 1000,
  invoiceStatus: 'paid',
  paymentStatus: 'reconciled',
  allocationRows: 1,
  reversalJournals: 0,
};

async function reverse(bankTxId: string, jwt: string, asCompany: string) {
  const req = request({ 'sb-access-token': jwt, active_company_id: asCompany }, 'POST');
  req.url = '/api/accounting/bank-transactions-action';
  req.body = { action: 'reverse', bankTransactionId: bankTxId };
  const result = response();
  await action(req, result.res);
  return result;
}

beforeAll(async () => {
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

  await seedFixture(alreadyReversed, 'already-reversed');
  await seedFixture(happyPath, 'happy');
  await seedFixture(crossTenant, 'cross-tenant');
  await seedFixture(closedToday, 'closed-today');
  await seedFixture(noPeriodToday, 'no-period-today');

  // Only the first fixture's journal is already reversed. reverseJournalEntry
  // refuses on `reversed_at`, and it refuses AFTER the unwind has written.
  await pool.query('UPDATE gl_journal_entries SET reversed_at = NOW(), reversed_by = $2 WHERE id = $1',
    [alreadyReversed.je, user]);

  for (const jwt of [{ id: user, set: (t: string) => { token = t; } }, { id: otherUser, set: (t: string) => { otherToken = t; } }]) {
    jwt.set(await new SignJWT({ sub: jwt.id, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET)));
  }
});

afterAll(async () => {
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
});

describe('K-021 reversal atomicity', () => {
  it('rolls the unwind back when the contra fails for a reason the pre-flight cannot see', async () => {
    // The period is open, so the pre-flight passes and the unwind RUNS. Only
    // the savepoint puts the invoice, the payment and the allocation back.
    const result = await reverse(alreadyReversed.bankTx, token, company);
    expect(result.state.statusCode).not.toBe(200);
    expect(await readState(alreadyReversed)).toEqual(UNTOUCHED);
  });

  it('still reverses cleanly when the contra can post, and the contra balances', async () => {
    const result = await reverse(happyPath.bankTx, token, company);
    expect(result.state.statusCode).toBe(200);
    expect(await readState(happyPath)).toEqual({
      bankTxStatus: 'imported',
      invoiceAmountPaid: 0,
      invoiceStatus: 'approved',
      paymentStatus: 'cancelled',
      allocationRows: 0,
      reversalJournals: 1,
    });

    // The contra is balanced AND mirrors the original leg for leg: the credit
    // that comes off the bank equals the debit put back on AR control, and the
    // invoice the subledger just reopened is owed exactly that again.
    const lines = await pool.query(
      `SELECT jl.gl_account_id, SUM(jl.debit)::numeric AS dr, SUM(jl.credit)::numeric AS cr
       FROM gl_journal_lines jl
       JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
       WHERE je.company_id=$1 AND je.reversal_of_id=$2 GROUP BY jl.gl_account_id`,
      [company, happyPath.je]);
    const byAccount = new Map(lines.rows.map((r) => [r.gl_account_id, { dr: Number(r.dr), cr: Number(r.cr) }]));
    expect(byAccount.get(bank)).toEqual({ dr: 0, cr: 1000 });
    expect(byAccount.get(arControl)).toEqual({ dr: 1000, cr: 0 });
    const totals = [...byAccount.values()].reduce((a, l) => ({ dr: a.dr + l.dr, cr: a.cr + l.cr }), { dr: 0, cr: 0 });
    expect(totals.dr).toBe(totals.cr);

    const inv = await pool.query(
      'SELECT total_amount - COALESCE(amount_paid,0) AS outstanding FROM customer_invoices WHERE id=$1', [happyPath.invoice]);
    expect(Number(inv.rows[0].outstanding)).toBe(byAccount.get(arControl)!.dr);
  });

  it('refuses a second reversal of the same line without posting a second contra', async () => {
    // Retry of the call that just succeeded: the bank line is back to
    // 'imported', which is not a reversible status.
    const result = await reverse(happyPath.bankTx, token, company);
    expect(result.state.statusCode).not.toBe(200);
    expect((await readState(happyPath)).reversalJournals).toBe(1);
  });

  it('refuses another tenant and leaves the line untouched', async () => {
    const result = await reverse(crossTenant.bankTx, otherToken, otherCompany);
    expect(result.state.statusCode).not.toBe(200);
    expect(await readState(crossTenant)).toEqual(UNTOUCHED);
  });

  // A guard that fronts a write must refuse only what the write refuses.
  // createJournalEntry calls ensureFiscalPeriodForDate, which CREATES the fiscal
  // year on demand, so a tenant whose current year does not exist yet could
  // always reverse an old allocation — the year was built on the way through.
  // Refusing `no_period` in the pre-flight would turn that into a 400.
  // Mutation: refuse on `status !== 'open'` and this goes red.
  it('still reverses when NO period covers today, because the poster creates the year', async () => {
    // Moved out of today's range rather than deleted: the happy-path contra
    // posted into this period, and both gl_journal_entries and
    // gl_account_balances carry an FK to it. Parking it leaves today uncovered,
    // which is the condition under test.
    await pool.query('UPDATE fiscal_periods SET start_date=$2::date, end_date=$3::date WHERE id=$1',
      [nowPeriod, parkedStart, parkedEnd]);
    const before = await pool.query(
      'SELECT COUNT(*)::int AS n FROM fiscal_periods WHERE company_id=$1 AND start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE',
      [company]);
    expect(before.rows[0].n).toBe(0);

    const result = await reverse(noPeriodToday.bankTx, token, company);
    expect(result.state.statusCode).toBe(200);
    expect((await readState(noPeriodToday)).reversalJournals).toBe(1);

    // The year was created on the way through, and the contra is IN it — a
    // reversal posted with a NULL period would be invisible to every
    // period-bounded report, which is the outcome the auto-create exists to stop.
    const after = await pool.query(
      'SELECT COUNT(*)::int AS n FROM fiscal_periods WHERE company_id=$1 AND start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE',
      [company]);
    expect(after.rows[0].n).toBe(1);
    const contra = await pool.query(
      'SELECT fiscal_period_id FROM gl_journal_entries WHERE company_id=$1 AND reversal_of_id=$2',
      [company, noPeriodToday.je]);
    expect(contra.rows[0].fiscal_period_id).not.toBeNull();
  });

  // Runs LAST: it closes every period covering today for the rest of the file.
  it('refuses BEFORE the unwind when the fallback reversal date has no open period', async () => {
    await pool.query(
      "UPDATE fiscal_periods SET status='closed' WHERE company_id=$1 AND start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE",
      [company]);
    const result = await reverse(closedToday.bankTx, token, company);

    expect(result.state.statusCode).not.toBe(200);
    expect(await readState(closedToday)).toEqual(UNTOUCHED);
    // The savepoint would also produce that state, so the message is what
    // separates a refusal from a rollback: the pre-flight names the date whose
    // period is closed, while a failure inside the contra reports
    // postJournalEntry's own 'Cannot post to closed fiscal period'.
    const message = (result.state.body as { error?: string; message?: string } | undefined);
    expect(JSON.stringify(message)).toMatch(/fiscal period covering \d{4}-\d{2}-\d{2} is not open \(closed or locked\)/);
  });
});
