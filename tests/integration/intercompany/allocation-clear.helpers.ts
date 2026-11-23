/**
 * Fixture for the intercompany P4-D (receiver clearing) suites, on top of the P4-B / P4-C ones. A (the RECEIVER, the issuer) clears B's
 * (the payer's) allocation message with one contra settlement: DR A's loan account / CR A's Accounts Receivable, through the real accept route
 * with real signed tokens (withAuth, CSRF off in tests as for the siblings). The pair is a GROUP loan connection whose two sides both mirror
 * (customer AND supplier linked, `mirroring_since` back-dated to the cut-over), so the pair's cut-over is 2026-01-01. A's loan account is an
 * asset of subtype other_current_asset and B's a liability of subtype other_current_liability (loan classes of opposite types); B's journal
 * credits B's loan account unless a case says otherwise.
 */
import type { Pool } from 'pg';
import acceptRoute from '../../../pages/api/accounting/intercompany/allocations/[id]/accept';
import { callRoute } from '../r035-approval.helpers';
import { acct, asAppUser, co, party, plantConnection, plantSide, tokens, U } from './intercompany.helpers';
import { acc, dataOf } from './mirror.helpers';
import { allocSetup, plantBill, plantPaid, sendFor } from './allocation.helpers';
import { allocationsApi } from './allocation-live.helpers';
import type { AllocationDetail } from '../../../src/modules/accounting/services/intercompany/allocationInboxTypes';

export const loan = { a2: '' };

/** The allocation fixture, A's loan account made a loan-class asset, a second one (a change of loan account), and U.mab without AR Approve in A. */
export async function clearSetup(pool: Pool): Promise<void> {
  await allocSetup(pool);
  await pool.query("UPDATE gl_accounts SET account_type = 'asset', normal_balance = 'debit', account_subtype = 'other_current_asset' WHERE id = $1", [acct.aLoan]);
  // (fix round 1, F1 / F5) B's loan account is a loan-class LIABILITY (the payer owes), A's a loan-class ASSET (the receiver is owed)
  await pool.query("UPDATE gl_accounts SET account_type = 'liability', normal_balance = 'credit', account_subtype = 'other_current_liability' WHERE id = $1", [acct.bLoan]);
  loan.a2 = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_accounts(id, company_id, account_code, account_name, account_type, normal_balance, is_active, account_subtype)
     VALUES ($1, $2, $3, 'IC A loan 2', 'asset', 'debit', true, 'other_current_asset')`, [loan.a2, co.A, `IL2${co.A.slice(0, 5)}`]);
  await pool.query(
    `INSERT INTO company_user_permissions (company_id, user_id, module_key, can_read, can_write, can_approve)
     VALUES ($1, $2, 'customers', true, true, false) ON CONFLICT DO NOTHING`, [co.A, U.mab]);
}

/** Both sides' mirroring_since back to the cut-over (the database sets it to tomorrow; a fixture moves it with the two side triggers off). */
export async function backdateMirroring(pool: Pool, conn: string, since = '2026-01-01'): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const t of ['trg_intercompany_sides_guard', 'trg_intercompany_sides_auto_since']) await client.query(`ALTER TABLE intercompany_connection_sides DISABLE TRIGGER ${t}`);
    await client.query("UPDATE intercompany_connection_sides SET mirroring_since = ($2::date)::timestamp AT TIME ZONE 'Africa/Johannesburg' WHERE connection_id = $1", [conn, since]);
    for (const t of ['trg_intercompany_sides_guard', 'trg_intercompany_sides_auto_since']) await client.query(`ALTER TABLE intercompany_connection_sides ENABLE ALWAYS TRIGGER ${t}`);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** A <-> B, loan mode, cut-over 2026-01-01, both sides with customer + supplier + loan account, both mirroring from the cut-over. */
export async function clearConnect(pool: Pool, over: { mode?: 'loan' | 'cash'; since?: string | null; aLoan?: string | null } = {}): Promise<string> {
  const id = await plantConnection(pool, co.A, co.B);
  await asAppUser(pool, U.ab, co.A, (q) => q.query("UPDATE intercompany_connections SET settlement_mode = $2, cutover_date = DATE '2026-01-01' WHERE id = $1",
    [id, over.mode ?? 'loan']), true);
  await plantSide(pool, id, co.A, co.B, {
    customer_id: party.aCustomer, supplier_id: party.aSupplier, ...(over.aLoan === null ? {} : { loan_account_id: over.aLoan ?? acct.aLoan }),
  });
  await plantSide(pool, id, co.B, co.A, { customer_id: party.bCustomer, supplier_id: party.bSupplier, default_expense_account_id: acc.bExp1, loan_account_id: acct.bLoan });
  if (over.since !== null) await backdateMirroring(pool, id, over.since ?? '2026-01-01');
  return id;
}

/** B pays its linked bill (A's invoice) from its LOAN account unless `leg` says otherwise; the database sends the message to A. */
export async function sentClearable(pool: Pool, conn: string, over: Parameters<typeof plantPaid>[2] = {}, bill: Parameters<typeof plantBill>[2] = {}) {
  const b = await plantBill(pool, conn, bill);
  const p = await plantPaid(pool, b.bill, { leg: acct.bLoan, ...over });
  const out = await sendFor(pool, p.allocation);
  if (!out.message_id) throw new Error(`the allocation was not sent: ${out.reason}`);
  return { ...b, ...p, message: out.message_id, amount: over.amount ?? 1150 };
}

/** A second allocation of the same payment (after an unapply), to `bill`, sent. */
export async function reapply(pool: Pool, payment: string, bill: string, amount: number): Promise<{ allocation: string; message: string }> {
  const allocation = (await pool.query('INSERT INTO payment_allocations(payment_id, invoice_id, amount_allocated) VALUES ($1, $2, $3) RETURNING id', [payment, bill, amount])).rows[0].id as string;
  const out = await sendFor(pool, allocation);
  if (!out.message_id) throw new Error(`the re-applied allocation was not sent: ${out.reason}`);
  return { allocation, message: out.message_id };
}

export interface AcceptBody { expectedLoanAccountId: string; invoiceId: string; amount: number; postingDate: string }
export const bodyFor = (s: { invoice: string; amount: number }, over: Partial<AcceptBody> = {}): AcceptBody =>
  ({ expectedLoanAccountId: acct.aLoan, invoiceId: s.invoice, amount: s.amount, postingDate: '2026-09-01', ...over });

const url = (id: string) => `/api/accounting/intercompany/allocations/${id}/accept`;
export const acceptAs = (user: string, company: string, id: string, body: unknown, token = tokens[user]!) =>
  callRoute(acceptRoute, token, company, 'POST', body, url(id), { id });
export const accept = (id: string, body: unknown) => acceptAs(U.a, co.A, id, body);

export interface Outcome { accepted: boolean; messageId: string; paymentId?: string; paymentNumber?: string; journalEntryId?: string; code?: string; error?: string; status?: string }
export const outcomeOf = (r: { state: { body: unknown } }) => dataOf<Outcome>(r);

export async function previewFor(id: string, user = U.a) {
  const res = await allocationsApi.get(user, co.A, id);
  return dataOf<AllocationDetail>(res);
}

/** The ledger as the cases judge it. */
export const ledger = {
  journals: async (pool: Pool, company = co.A) => Number((await pool.query('SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id = $1', [company])).rows[0].n),
  receipts: async (pool: Pool, company = co.A) => Number((await pool.query('SELECT count(*)::int AS n FROM customer_payments WHERE company_id = $1', [company])).rows[0].n),
  /** Net debit of posted lines on an account. */
  balance: async (pool: Pool, account: string) => Number((await pool.query(
    `SELECT COALESCE(sum(l.debit - l.credit), 0)::float8 AS b FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.journal_entry_id
      WHERE l.gl_account_id = $1 AND e.status = 'posted'`, [account])).rows[0].b),
  open: async (pool: Pool, invoice: string) => Number((await pool.query('SELECT (total_amount - COALESCE(amount_paid, 0))::float8 AS o FROM customer_invoices WHERE id = $1', [invoice])).rows[0].o),
  message: async (pool: Pool, id: string) => (await pool.query('SELECT status, error, reason, target_doc_type, target_doc_id, handled_by, handled_via FROM intercompany_messages WHERE id = $1', [id])).rows[0],
  lines: async (pool: Pool, journal: string) => (await pool.query(
    'SELECT gl_account_id, debit::float8 AS debit, credit::float8 AS credit, company_id FROM gl_journal_lines WHERE journal_entry_id = $1 ORDER BY debit DESC', [journal])).rows,
  ar: async (pool: Pool, company = co.A) => (await pool.query("SELECT id FROM gl_accounts WHERE company_id = $1 AND account_subtype = 'receivable' AND is_system_account", [company])).rows[0].id as string,
};

/** A journal of B crediting its loan account `loanPart` and its bank the rest (a split cash leg), posted and standing. */
export async function plantSplitJournal(pool: Pool, total: number, loanPart: number, bankAccount: string): Promise<string> {
  const id = (await pool.query(
    `INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id) VALUES (DATE '2026-09-01', 'Split payment (planted)', 'auto_supplier_payment', 'draft', $1, $2) RETURNING id`,
    [U.ab, co.B])).rows[0].id as string;
  const ap = (await pool.query("SELECT id FROM gl_accounts WHERE company_id = $1 AND account_subtype = 'payable' LIMIT 1", [co.B])).rows[0].id as string;
  for (const [account, debit, credit] of [[ap, total, 0], [acct.bLoan, 0, loanPart], [bankAccount, 0, total - loanPart]] as const) {
    await pool.query('INSERT INTO gl_journal_lines(journal_entry_id, gl_account_id, debit, credit, company_id, description) VALUES ($1, $2, $3, $4, $5, $6)', [id, account, debit, credit, co.B, 'planted']);
  }
  await pool.query("UPDATE gl_journal_entries SET status = 'posted', posted_at = now() WHERE id = $1", [id]);
  return id;
}
