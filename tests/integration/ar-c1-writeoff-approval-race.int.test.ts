/**
 * AR audit 2026-10-18, C1 + C2 (K-055) — a write-off must be judged against the
 * invoice AS IT IS when it is approved, under the invoice's row lock.
 *
 * C1. Approval re-read neither the invoice's balance nor its status and took no
 * lock on it. A draft write-off for the full balance, then the customer pays
 * (or a second write-off is approved), then the first is approved: AR credited
 * twice, amount_paid 2x total, bad debt and VAT Act s22(3) relief booked on
 * money already collected.
 *
 * C2. createWriteOff accepted a draft / pending_approval / cancelled /
 * soft-deleted invoice; approval then credited AR that was never debited.
 *
 * Driven through the real handlers (write-offs, write-offs-action, and the
 * receipt routes for the other party). Every claim is by OUTCOME: the invoice's
 * final amount_paid, and what the AR control account was actually credited by
 * posted journals. Races are made deterministic by parking one request after
 * it has read, then releasing it only once the other has finished or is waiting
 * on the invoice row lock. Disposable fixture DB only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';

const gate = vi.hoisted(() => ({ hold: null as null | Promise<void>, entered: null as null | (() => void), on: '' }));

// Approval parks where it resolves the AR account: after its claim and (once
// fixed) after it has locked and judged the invoice, before it writes anything.
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/gl/systemAccountResolver')>();
  return {
    ...actual,
    getSystemAccount: async (...a: Parameters<typeof actual.getSystemAccount>) => {
      const account = await actual.getSystemAccount(...a);
      if (gate.on === 'receivable-lookup' && a[0] === 'receivable' && gate.hold) {
        const hold = gate.hold; gate.hold = null; gate.on = ''; gate.entered?.(); await hold;
      }
      return account;
    },
  };
});

// A receipt confirm parks once it has returned (invoice + receipt UPDATEd) and before
// the route answers, so `withAuth` has not yet committed: the invoice row stays locked.
vi.mock('@/lib/apiJournalDate', async (orig) => {
  const actual = await orig<typeof import('@/lib/apiJournalDate')>();
  return {
    ...actual,
    withJournalDateRefusal: async (...a: Parameters<typeof actual.withJournalDateRefusal>) => {
      const out = await actual.withJournalDateRefusal(...a);
      if (gate.on === 'receipt-confirmed' && gate.hold) {
        const hold = gate.hold; gate.hold = null; gate.on = ''; gate.entered?.(); await hold;
      }
      return out;
    },
  };
});

import writeOffs from '../../pages/api/accounting/write-offs';
import writeOffsAction from '../../pages/api/accounting/write-offs-action';
import customerPayments from '../../pages/api/accounting/customer-payments';
import customerPaymentsAction from '../../pages/api/accounting/customer-payments-action';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { routeCaller, type Route } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const company = crypto.randomUUID(), user = crypto.randomUUID(), customer = crypto.randomUUID();
const arAccount = crypto.randomUUID(), bankAccount = crypto.randomUUID();
const tokens: Record<string, string> = {};
const call = routeCaller(tokens, { user, company });

const TOTAL = 1150;
let seq = 0;

/** A 1150.00 invoice (1000 + 150 VAT) in `status`, optionally already part-paid. */
async function seedInvoice(status = 'approved', amountPaid = 0): Promise<string> {
  const id = crypto.randomUUID();
  seq += 1;
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,customer_id,client_id,invoice_number,invoice_date,due_date,
                                   subtotal,tax_amount,total_amount,amount_paid,status,created_by)
     VALUES($1,$2,$3,$3,$4,'2026-03-01','2026-03-31',1000,150,1150,$5,$6,$7)`,
    [id, company, customer, `C1WO-${seq}-${id.slice(0, 6)}`, amountPaid, status, user]);
  return id;
}

const createWo = (invoiceId: string, amount = TOTAL) =>
  call(writeOffs as Route, 'POST', '/api/accounting/write-offs', undefined, {
    body: { clientId: customer, invoiceId, amount, reason: 'irrecoverable', writeOffDate: '2026-04-01' } });
const act = (action: 'approve' | 'cancel', id: string) =>
  call(writeOffsAction as Route, 'POST', '/api/accounting/write-offs-action', undefined, { body: { action, id } });

async function draftWo(invoiceId: string, amount = TOTAL): Promise<string> {
  const made = await createWo(invoiceId, amount);
  if (made.statusCode !== 200) throw new Error(`create write-off: ${made.statusCode} ${JSON.stringify(made.body)}`);
  return String(made.body.data!.id);
}

/** A draft receipt for the invoice's full total, made by the route. */
async function draftReceipt(invoiceId: string, amount = TOTAL): Promise<string> {
  const made = await call(customerPayments as Route, 'POST', '/api/accounting/customer-payments', undefined, {
    body: { clientId: customer, paymentDate: '2026-04-02', totalAmount: amount, paymentMethod: 'eft',
      bankAccountId: bankAccount, allocations: [{ invoiceId, amount }] } });
  if (made.statusCode >= 300) throw new Error(`create receipt: ${made.statusCode} ${JSON.stringify(made.body)}`);
  return String(made.body.data!.id);
}
const confirmReceipt = (paymentId: string) =>
  call(customerPaymentsAction as Route, 'POST', '/api/accounting/customer-payments-action', undefined,
    { body: { action: 'confirm', paymentId } });

async function arCredited(): Promise<number> {
  const r = await pool.query(
    `SELECT COALESCE(SUM(jl.credit),0)::float8 AS c FROM gl_journal_lines jl
       JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.company_id=$1 AND je.status='posted' AND jl.gl_account_id=$2`, [company, arAccount]);
  return Number(r.rows[0].c);
}
const invoice = async (id: string) => (await pool.query(
  'SELECT amount_paid::float8 AS paid, status, paid_at FROM customer_invoices WHERE id=$1', [id])).rows[0] as
  { paid: number; status: string; paid_at: Date | null };
const woStatus = async (id: string) => String((await pool.query(
  'SELECT status FROM customer_write_offs WHERE id=$1', [id])).rows[0].status);
const woJournals = async (...ids: string[]) => Number((await pool.query(
  'SELECT count(gl_journal_entry_id) AS n FROM customer_write_offs WHERE id = ANY($1::uuid[])', [ids])).rows[0].n);

/** 'waiting' once a backend of this database waits on a lock in a statement over `table`. */
async function waitsOnLock(table: string): Promise<'waiting'> {
  for (let i = 0; i < 500; i += 1) {
    const r = await pool.query(
      `SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1`, [`%${table}%`]);
    if (r.rowCount) return 'waiting';
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`nothing finished and nothing waited on a ${table} lock`);
}

function park(on: 'receivable-lookup' | 'receipt-confirmed') {
  let release!: () => void;
  gate.hold = new Promise<void>((r) => { release = r; });
  gate.on = on;
  const entered = new Promise<void>((r) => { gate.entered = r; });
  return { release, entered };
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'C1 write-off approval race']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'C1 customer']);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,
                             is_system_account,is_active)
     VALUES($1,$2,'1200','Accounts Receivable','asset','receivable','debit',true,true),
           (gen_random_uuid(),$2,'6100','Bad Debts','expense','admin_expense','debit',true,true),
           (gen_random_uuid(),$2,'2200','VAT Output','liability','vat_output','credit',true,true),
           ($3,$2,'1000','Bank','asset','bank','debit',true,true)`,
    [arAccount, company, bankAccount]);
  tokens[user] = await new SignJWT({ sub: user, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

afterAll(async () => {
  try {
    const q = (text: string) => pool.query(text, [company]);
    await q('UPDATE customer_write_offs SET gl_journal_entry_id=NULL WHERE company_id=$1');
    await q('DELETE FROM customer_payment_allocations WHERE payment_id IN (SELECT id FROM customer_payments WHERE company_id=$1)');
    await q('DELETE FROM customer_payments WHERE company_id=$1');
    await q('DELETE FROM gl_journal_lines WHERE journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE company_id=$1)');
    await q('UPDATE gl_journal_entries SET reversal_of_id = NULL WHERE company_id=$1');
    await q('DELETE FROM gl_journal_entries WHERE company_id=$1');
    await q('DELETE FROM customer_write_offs WHERE company_id=$1');
    await q('DELETE FROM customer_invoices WHERE company_id=$1');
    await q('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)');
    await q('DELETE FROM gl_accounts WHERE company_id=$1');
    await q('DELETE FROM customers WHERE company_id=$1');
    await q('DELETE FROM company_document_numbers WHERE company_id=$1');
    await q('DELETE FROM fiscal_periods WHERE company_id=$1');
    await q('DELETE FROM company_users WHERE company_id=$1');
    await q('DELETE FROM companies WHERE id=$1');
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

describe('C1 — approval judges the invoice as it is now', () => {
  it('refuses a write-off whose invoice was paid in full after it was drafted; nothing posts, it stays cancellable', async () => {
    const inv = await seedInvoice();
    const wo = await draftWo(inv);
    expect((await confirmReceipt(await draftReceipt(inv))).statusCode).toBe(200);
    expect(await invoice(inv)).toMatchObject({ paid: TOTAL, status: 'paid' });
    const before = await arCredited();

    const refused = await act('approve', wo);

    expect(refused.statusCode).toBe(409);
    expect((await invoice(inv)).paid).toBe(TOTAL);
    expect(await arCredited() - before).toBe(0);
    expect(await woJournals(wo)).toBe(0);
    expect(await woStatus(wo)).toBe('draft');
    expect((await act('cancel', wo)).statusCode).toBe(200);
    expect(await woStatus(wo)).toBe('cancelled');
  });

  it('refuses a write-off larger than what is still owing after a part payment', async () => {
    const inv = await seedInvoice('approved', 800);
    const wo = await draftWo(inv, 350);
    await pool.query('UPDATE customer_invoices SET amount_paid = 900 WHERE id = $1', [inv]);
    const before = await arCredited();

    expect((await act('approve', wo)).statusCode).toBe(409);
    expect((await invoice(inv)).paid).toBe(900);
    expect(await arCredited() - before).toBe(0);
    expect(await woStatus(wo)).toBe('draft');
  });

  it.each([
    ['cancelled', "UPDATE customer_invoices SET status = 'cancelled' WHERE id = $1"],
    ['soft-deleted', 'UPDATE customer_invoices SET deleted_at = NOW() WHERE id = $1'],
  ])('refuses to approve once the invoice has been %s (C2, approval half)', async (_name, change) => {
    const inv = await seedInvoice();
    const wo = await draftWo(inv);
    await pool.query(change, [inv]);
    const before = await arCredited();

    expect((await act('approve', wo)).statusCode).toBe(409);
    expect((await invoice(inv)).paid).toBe(0);
    expect(await arCredited() - before).toBe(0);
    expect(await woJournals(wo)).toBe(0);
    expect(await woStatus(wo)).toBe('draft');
  });

  it('of two draft write-offs for the full balance approved at once, exactly one posts', async () => {
    const inv = await seedInvoice();
    const first = await draftWo(inv), second = await draftWo(inv);
    const before = await arCredited();

    const held = park('receivable-lookup');
    const firstP = act('approve', first); // claims, then parks before it posts
    await held.entered;
    const secondP = act('approve', second);
    const state = await Promise.race([secondP.then(() => 'finished' as const), waitsOnLock('customer_invoices')]);
    held.release();
    const [a, b] = await Promise.all([firstP, secondP]);

    // Outcomes first: the invoice is settled once, AR credited once, one write-off posted.
    expect((await invoice(inv)).paid).toBe(TOTAL);
    expect(await arCredited() - before).toBe(TOTAL);
    expect(await woJournals(first, second)).toBe(1);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(409);
    expect(await woStatus(second)).toBe('draft');
    // And the second got there by waiting on the invoice the first held.
    expect(state).toBe('waiting');
  });

  it('a write-off approval racing a receipt confirm for the full balance cannot take amount_paid past total', async () => {
    const inv = await seedInvoice();
    const wo = await draftWo(inv);
    const receipt = await draftReceipt(inv);
    const before = await arCredited();

    const held = park('receipt-confirmed');
    const confirmP = confirmReceipt(receipt); // writes the invoice, then parks uncommitted
    await held.entered;
    const approveP = act('approve', wo);
    // Not table-specific: unfixed, the approval queues on the journal-number advisory lock the
    // parked confirm holds; fixed, on the invoice row. Either way it waits, and the outcome decides.
    const state = await Promise.race([approveP.then(() => 'finished' as const), waitsOnLock('')]);
    held.release();
    const [confirmed, approved] = await Promise.all([confirmP, approveP]);

    expect((await invoice(inv)).paid).toBe(TOTAL);
    expect(await arCredited() - before).toBe(TOTAL); // the receipt's credit only
    expect(await woJournals(wo)).toBe(0);
    expect(confirmed.statusCode).toBe(200);
    expect(approved.statusCode).toBe(409);
    expect(await woStatus(wo)).toBe('draft');
    expect(state).toBe('waiting');
  });

  it('a write-off approved first leaves a draft receipt for the same balance refused at confirm', async () => {
    const inv = await seedInvoice();
    const wo = await draftWo(inv);
    const receipt = await draftReceipt(inv);
    expect((await act('approve', wo)).statusCode).toBe(200);
    const before = await arCredited();

    const refused = await confirmReceipt(receipt);

    expect(refused.statusCode).toBe(400);
    expect((await invoice(inv)).paid).toBe(TOTAL);
    expect(await arCredited() - before).toBe(0);
    expect(String((await pool.query('SELECT status FROM customer_payments WHERE id=$1', [receipt])).rows[0].status)).toBe('draft');
  });

  it('a receipt confirm that queues behind a parked approval neither deadlocks nor times out: one settles, one is refused', async () => {
    const inv = await seedInvoice();
    const wo = await draftWo(inv);
    const receipt = await draftReceipt(inv);
    const before = await arCredited();

    const held = park('receivable-lookup');
    const approveP = act('approve', wo); // holds the invoice row, parks before it posts
    await held.entered;
    const confirmP = confirmReceipt(receipt);
    const state = await Promise.race([confirmP.then(() => 'finished' as const), waitsOnLock('')]);
    held.release();
    const [approved, confirmed] = await Promise.all([approveP, confirmP]);

    expect((await invoice(inv)).paid).toBe(TOTAL);
    expect(await arCredited() - before).toBe(TOTAL); // exactly one settlement posted
    expect(approved.statusCode).toBe(200);
    expect(confirmed.statusCode).toBe(400); // refused, not 503 (lock timeout) or 500 (deadlock)
    expect(await woJournals(wo)).toBe(1);
    expect(state).toBe('waiting');
  });

  it('still approves a valid write-off: full balance -> paid and dated, part -> partially_paid', async () => {
    const full = await seedInvoice();
    const fullWo = await draftWo(full);
    const before = await arCredited();
    const ok = await act('approve', fullWo);
    expect(ok.statusCode).toBe(200);
    const done = await invoice(full);
    expect(done).toMatchObject({ paid: TOTAL, status: 'paid' });
    expect(done.paid_at).not.toBeNull();
    expect(await arCredited() - before).toBe(TOTAL);

    const part = await seedInvoice('sent');
    const partWo = await draftWo(part, 500);
    expect((await act('approve', partWo)).statusCode).toBe(200);
    expect(await invoice(part)).toMatchObject({ paid: 500, status: 'partially_paid' });
  });
});

describe('C2 — a write-off cannot be raised against an invoice with no posted AR', () => {
  const writeOffRows = async (inv: string) => Number((await pool.query(
    'SELECT count(*) AS n FROM customer_write_offs WHERE invoice_id=$1', [inv])).rows[0].n);

  it.each(['draft', 'pending_approval', 'cancelled'])('refuses a %s invoice', async (status) => {
    const inv = await seedInvoice(status);
    const refused = await createWo(inv);
    expect(refused.statusCode).toBe(400);
    expect(await writeOffRows(inv)).toBe(0);
  });

  it('refuses a soft-deleted invoice', async () => {
    const inv = await seedInvoice();
    await pool.query('UPDATE customer_invoices SET deleted_at = NOW() WHERE id = $1', [inv]);
    expect((await createWo(inv)).statusCode).toBe(400);
    expect(await writeOffRows(inv)).toBe(0);
  });

  it.each(['approved', 'sent', 'overdue', 'partially_paid'])('accepts a %s invoice', async (status) => {
    const inv = await seedInvoice(status, status === 'partially_paid' ? 150 : 0);
    expect((await createWo(inv, 1000)).statusCode).toBe(200);
    expect(await writeOffRows(inv)).toBe(1);
  });

  it('still refuses an amount above the balance', async () => {
    const inv = await seedInvoice('approved', 200);
    expect((await createWo(inv, 951)).statusCode).toBe(400);
    expect(await writeOffRows(inv)).toBe(0);
  });
});
