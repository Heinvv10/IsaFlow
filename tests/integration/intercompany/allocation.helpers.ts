/**
 * Fixture for the intercompany P4-B (allocation sender) suites. A is the ISSUER (its customer is B), B is the PAYER: B owes A, pays A's
 * invoice (B's bill), and the database writes one `allocation` message B -> A per `payment_allocations` row of a LOAN connection whose
 * bill is in an ACTIVE link with A's customer invoice. Everything is planted as the table owner (the guards that are NOT under test are
 * switched off for the one INSERT, or satisfied); the definer under test is called as app_user, as withAuth opens a request.
 */
import type { Pool } from 'pg';
import { acct, asAppUser, co, pairOf, party, plantConnection, plantSide, U, withoutTrigger } from './intercompany.helpers';
import { acc, mirrorSetup, plantArInvoice, rawReverseJournal } from './mirror.helpers';

export interface SendRow { message_id: string | null; reason: string | null; detail: string | null }
export const bank = { b: '' };

/** The mirror fixture plus what a payment of B needs: a bank account, and a supplier with bank details. */
export async function allocSetup(pool: Pool): Promise<void> {
  await mirrorSetup(pool);
  bank.b = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_accounts(id, company_id, account_code, account_name, account_type, normal_balance, is_active, account_subtype, bank_account_number, bank_branch_code)
     VALUES ($1, $2, $3, 'IC B bank', 'asset', 'debit', true, 'bank', '40000000001', '250655')`, [bank.b, co.B, `BK${co.B.slice(0, 6)}`]);
  await pool.query(
    `UPDATE suppliers SET bank_name = 'IC Bank', bank_account_number = '62000000001', bank_branch_code = '250655', bank_account_type = 'current',
            bank_account_holder = 'IC Holder' WHERE id = $1`, [party.bSupplier]);
}

/** A <-> B: cut-over, settlement mode, and B's loan account (the bank leg of a contra settlement). */
export async function loanConnect(pool: Pool, over: { mode?: 'loan' | 'cash'; cutover?: string | null; loan?: boolean } = {}): Promise<string> {
  const id = await plantConnection(pool, co.A, co.B);
  const cutover = over.cutover === undefined ? '2026-01-01' : over.cutover;
  await asAppUser(pool, U.ab, co.A, (q) => q.query('UPDATE intercompany_connections SET settlement_mode = $2, cutover_date = $3 WHERE id = $1',
    [id, over.mode ?? 'loan', cutover]), true);
  await plantSide(pool, id, co.A, co.B, { customer_id: party.aCustomer, loan_account_id: acct.aLoan });
  await plantSide(pool, id, co.B, co.A, {
    supplier_id: party.bSupplier, default_expense_account_id: acc.bExp1, ...(over.loan === false ? {} : { loan_account_id: acct.bLoan }),
  });
  return id;
}

/** A link between A's customer invoice and B's bill, with the pair's order (the table orders its companies), the links guard off. */
export async function linkBill(pool: Pool, conn: string, invoice: string, bill: string, status = 'active', origin = 'manual_pairing'): Promise<string> {
  const aIsLow = pairOf(co.A, co.B)[0] === co.A;
  const [ca, ta, da, cb, tb, db] = aIsLow
    ? [co.A, 'customer_invoice', invoice, co.B, 'supplier_invoice', bill]
    : [co.B, 'supplier_invoice', bill, co.A, 'customer_invoice', invoice];
  return withoutTrigger(pool, 'intercompany_document_links', 'trg_intercompany_links_guard', async (q) => (await q.query(
    `INSERT INTO intercompany_document_links(connection_id, company_a_id, doc_a_type, doc_a_id, company_b_id, doc_b_type, doc_b_id, origin, status, created_by, confirmed_by_a, confirmed_by_b)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $10) RETURNING id`, [conn, ca, ta, da, cb, tb, db, origin, status, U.ab])).rows[0].id as string);
}

/** B's approved bill (R1 150 in rand), and A's approved invoice it pays; `link: false` leaves them unlinked. */
export async function plantBill(pool: Pool, conn: string, over: { link?: boolean | string; total?: number; currency?: string; company?: string } = {}) {
  const company = over.company ?? co.B;
  const bill = crypto.randomUUID();
  const total = over.total ?? 1150;
  await pool.query(
    `INSERT INTO supplier_invoices(id, company_id, invoice_number, supplier_id, invoice_date, due_date, subtotal, tax_rate, tax_amount, total_amount,
       currency, currency_code, exchange_rate, status, created_by)
     VALUES ($1, $2, $3, $4, DATE '2026-09-01', DATE '2026-10-01', $5, 15, 0, $5, $6, $6, 1, 'approved', $7)`,
    [bill, company, `ICB-${bill.slice(0, 8)}`, company === co.B ? party.bSupplier : party.aSupplier, total, over.currency ?? 'ZAR', U.ab]);
  const invoice = (await plantArInvoice(pool, { status: 'approved' })).id;
  const link = over.link === false ? null : await linkBill(pool, conn, invoice, bill, typeof over.link === 'string' ? over.link : 'active');
  return { bill, invoice, link };
}

/** A posted payment journal of B (DR payable, CR the bank leg) that stands, or `reversed` by its negation. */
export async function plantPaymentJournal(pool: Pool, amount: number, over: { company?: string; leg?: string; reversed?: boolean; status?: string } = {}): Promise<string> {
  const company = over.company ?? co.B;
  const id = (await pool.query(
    `INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id) VALUES (DATE '2026-09-01', 'Supplier payment (planted)', 'auto_supplier_payment', 'draft', $1, $2) RETURNING id`,
    [U.ab, company])).rows[0].id as string;
  // a company with no payable account (the issuer's chart has none) debits its own loan account: only the journal's company matters
  const ap = (await pool.query("SELECT id FROM gl_accounts WHERE company_id = $1 AND account_subtype = 'payable' LIMIT 1", [company])).rows[0]?.id as string ?? acct.aExpense;
  const line = (account: string, debit: number, credit: number) => pool.query(
    'INSERT INTO gl_journal_lines(journal_entry_id, gl_account_id, debit, credit, company_id, description) VALUES ($1, $2, $3, $4, $5, $6)', [id, account, debit, credit, company, 'planted']);
  await line(ap, amount, 0);
  await line(over.leg ?? bank.b, 0, amount);
  if ((over.status ?? 'posted') === 'posted') await pool.query("UPDATE gl_journal_entries SET status = 'posted', posted_at = now() WHERE id = $1", [id]);
  if (over.reversed) await rawReverseJournal(pool, id);
  return id;
}

/** A payment of B for `bill` with its allocation row. `journal: false` = none; a string = that journal; a batch member takes the batch's. */
export async function plantPaid(pool: Pool, bill: string, over: {
  status?: string; date?: string; amount?: number; journal?: boolean | string; leg?: string; payment?: string; batch?: string; reversed?: boolean; allocate?: boolean; memberBank?: string; provisional?: string;
  /** payment_method (default eft); `contra` is what settle_by_contra writes */
  method?: string;
} = {}) {
  const amount = over.amount ?? 1150;
  const status = over.status ?? 'processed';
  let payment = over.payment ?? null;
  let journal: string | null = null;
  if (!payment) {
    journal = typeof over.journal === 'string' ? over.journal
      : over.journal === false || over.batch || status === 'draft' || status === 'approved' ? null
        : await plantPaymentJournal(pool, amount, { leg: over.leg, reversed: over.reversed });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // the approval trigger's own exemption (the bank-feed path): a fixture plants an approved / processed payment without a request
      await client.query("SELECT set_config('isaflow.approval_gate_exempt', 'bank_feed', true)");
      payment = (await client.query(
        `INSERT INTO supplier_payments(company_id, supplier_id, payment_date, total_amount, payment_method, bank_account_id, reference, status, batch_id, gl_journal_entry_id, created_by, settles_provisional_je_id)
         VALUES ($1, $2, $3::date, $4, $11, $5, 'IC alloc ref', $6, $7, $8, $9, $10) RETURNING id`,
        [co.B, party.bSupplier, over.date ?? '2026-09-01', amount, over.batch ? over.memberBank ?? null : over.leg ?? bank.b, status, over.batch ?? null, journal, U.ab, over.provisional ?? null, over.method ?? 'eft'])).rows[0].id as string;
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  const allocation = over.allocate === false ? ''
    : (await pool.query('INSERT INTO payment_allocations(payment_id, invoice_id, amount_allocated) VALUES ($1, $2, $3) RETURNING id', [payment, bill, amount])).rows[0].id as string;
  return { payment: payment as string, allocation, journal };
}

/** The definer as a session of `company` (committed): what the hook calls. */
export const sendFor = (pool: Pool, allocation: string, user = U.b, company = co.B) => asAppUser(pool, user, company,
  async (q) => (await q.query('SELECT * FROM public.intercompany_send_for_allocation($1)', [allocation])).rows[0] as SendRow, true);

export const allocationMessages = async (pool: Pool, allocation?: string) => (await pool.query(
  `SELECT * FROM intercompany_messages WHERE kind = 'allocation' ${allocation ? 'AND source_doc_id = $1' : ''} ORDER BY created_at`, allocation ? [allocation] : [])).rows;

/** Every row a test planted for B's side of the pair, so the next test starts from nothing (the message rows go with wipeConnections). */
export async function clearPayments(pool: Pool): Promise<void> {
  await pool.query('UPDATE supplier_payments SET gl_journal_entry_id = NULL WHERE company_id = ANY($1)', [[co.A, co.B, co.C]]);
  await pool.query('UPDATE supplier_payment_batches SET gl_journal_entry_id = NULL WHERE company_id = ANY($1)', [[co.A, co.B, co.C]]);
  await pool.query('DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM supplier_payments WHERE company_id = ANY($1))', [[co.A, co.B, co.C]]);
  await pool.query('DELETE FROM supplier_payments WHERE company_id = ANY($1)', [[co.A, co.B, co.C]]);
  await pool.query('DELETE FROM supplier_payment_batches WHERE company_id = ANY($1)', [[co.A, co.B, co.C]]);
}

/** A processed batch of `company` (B) with its own journal (or none) and bank account; its members are planted with `plantPaid({ batch })`. */
export async function plantBatchRow(pool: Pool, over: { company?: string; journal?: string | null; bank?: string } = {}): Promise<string> {
  const company = over.company ?? co.B;
  return (await pool.query(
    `INSERT INTO supplier_payment_batches(company_id, batch_date, payment_method, bank_account_id, payment_count, total_amount, created_by, status, gl_journal_entry_id)
     VALUES ($1, DATE '2026-09-01', 'eft', $2, 1, 1150, $3, 'processed', $4) RETURNING id`,
    [company, over.bank ?? bank.b, U.ab, over.journal ?? null])).rows[0].id as string;
}
