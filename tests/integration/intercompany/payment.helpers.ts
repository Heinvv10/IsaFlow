/**
 * Fixture for the intercompany F (payment message + match suggestions) suites, on top of P4-E's. B is the PAYER P: it pays its bill (the AP side
 * of an ACTIVE link to A's customer invoice) from its BANK on the GROUP CASH connection A <-> B (cut-over 2026-01-01, both sides mirroring);
 * the database writes ONE `payment` message B -> A per payment_allocations row (`intercompany_send_for_payment`, migration 1031). A is the
 * RECEIVER R: it sees the message, its state word, match suggestions over its OWN rows, and accepts it as an existing receipt or a draft one.
 * C is a third company moved into group G with a connection to B only (never to A). Everything is planted as the table owner unless a test is
 * about the guard; the definers and routes run as app_user (withAuth's shape) with real signed tokens.
 */
import type { Pool, PoolClient } from 'pg';
import paymentsRoute from '../../../pages/api/accounting/intercompany/payments';
import paymentRoute from '../../../pages/api/accounting/intercompany/payments/[id]/index';
import acceptRoute from '../../../pages/api/accounting/intercompany/payments/[id]/accept';
import discardRoute from '../../../pages/api/accounting/intercompany/payments/[id]/discard-draft';
import rejectRoute from '../../../pages/api/accounting/intercompany/payments/[id]/reject';
import dismissRoute from '../../../pages/api/accounting/intercompany/payments/[id]/dismiss';
import restoreRoute from '../../../pages/api/accounting/intercompany/payments/[id]/restore';
import unsentRoute from '../../../pages/api/accounting/intercompany/payments/unsent';
import receiptStateRoute from '../../../pages/api/accounting/intercompany/payments/receipt-state';
import receiptActionRoute from '../../../pages/api/accounting/customer-payments-action';
import { callRoute } from '../r035-approval.helpers';
import { acct, asAppUser, co, party, plantConnection, plantSide, tokens, U } from './intercompany.helpers';
import { dataOf } from './mirror.helpers';
import { bank, plantBill, plantPaid } from './allocation.helpers';
import { clearConnect } from './allocation-clear.helpers';
import { payerSetup } from './payer-clear.helpers';

export interface SendRow { message_id: string | null; reason: string | null; detail: string | null }
export const rbank = { a: '', a2: '', aInactive: '' };
export const cside = { conn: '' };

/** P4-E's fixture, A's two bank accounts (and an inactive one), and C moved into group G (a third company of the group). */
export async function paymentSetup(pool: Pool): Promise<void> {
  await payerSetup(pool);
  for (const k of Object.keys(rbank) as (keyof typeof rbank)[]) rbank[k] = crypto.randomUUID();
  const tag = co.A.slice(0, 5);
  for (const [id, code, active] of [[rbank.a, `BA1${tag}`, true], [rbank.a2, `BA2${tag}`, true], [rbank.aInactive, `BA3${tag}`, false]] as const) {
    await pool.query(
      `INSERT INTO gl_accounts(id, company_id, account_code, account_name, account_type, normal_balance, is_active, account_subtype)
       VALUES ($1, $2, $3, $3, 'asset', 'debit', $4, 'bank')`, [id, co.A, code, active]);
  }
  // U.ab writes in C too, so it can create the B <-> C group connection (a group connection needs a write role in both companies)
  await pool.query("INSERT INTO company_users(company_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING", [co.C, U.ab]);
  // a member row is retired, never moved: C leaves H and joins G
  await pool.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [co.H, co.C]);
  await pool.query('INSERT INTO company_group_members(group_id, company_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [co.G, co.C]);
}

/** A <-> B on CASH (the F mode), both sides mirroring from the cut-over. */
export const cashConnect = (pool: Pool, over: Parameters<typeof clearConnect>[1] = {}) => clearConnect(pool, { mode: 'cash', ...over });

/** B <-> C on `mode`: C's side names C's own customer for B (no supplier), B's side nothing (B's supplier stays on A <-> B). */
export async function connectBC(pool: Pool, mode: 'cash' | 'loan' = 'cash'): Promise<string> {
  const id = await plantConnection(pool, co.B, co.C, U.ab);
  await asAppUser(pool, U.ab, co.B, (q) => q.query("UPDATE intercompany_connections SET settlement_mode = $2, cutover_date = DATE '2026-01-01' WHERE id = $1", [id, mode]), true);
  await plantSide(pool, id, co.B, co.C, {});
  cside.conn = id;
  return id;
}

const SEND = 'SELECT * FROM public.intercompany_send_for_payment($1)';
/** D1 as a session of `company` (committed): what the hook calls second. */
export const sendPay = (pool: Pool, allocation: string | null, user = U.b, company = co.B) => asAppUser(pool, user, company,
  async (q) => (await q.query(SEND, [allocation])).rows[0] as SendRow, true);
/** D3 (the allocation sender) the same way. */
export const sendAlloc = (pool: Pool, allocation: string, user = U.b, company = co.B) => asAppUser(pool, user, company,
  async (q) => (await q.query('SELECT * FROM public.intercompany_send_for_allocation($1)', [allocation])).rows[0] as SendRow, true);

/** B pays its linked bill from the bank (cash leg = B's bank) and the database sends the payment message to A. */
export async function sentPayment(pool: Pool, conn: string, over: Parameters<typeof plantPaid>[2] = {}, bill: Parameters<typeof plantBill>[2] = {}) {
  const b = await plantBill(pool, conn, bill);
  const p = await plantPaid(pool, b.bill, over);
  const out = await sendPay(pool, p.allocation);
  if (!out.message_id) throw new Error(`the payment message was not sent: ${out.reason}`);
  return { ...b, ...p, message: out.message_id, amount: over.amount ?? 1150 };
}

export const paymentMessages = async (pool: Pool, allocation?: string) => (await pool.query(
  `SELECT * FROM intercompany_messages WHERE kind = 'payment' ${allocation ? 'AND source_doc_id = $1' : ''} ORDER BY created_at`, allocation ? [allocation] : [])).rows;

/** D2 as `user` of `company` (rolled back). */
export const stateOf = (pool: Pool, message: string, user = U.a, company = co.A) => asAppUser(pool, user, company,
  async (q) => (await q.query('SELECT live, state FROM public.intercompany_payment_message_state($1)', [message])).rows as { live: boolean; state: string }[]);

/** A posted receipt journal of A: DR `bankAccount` / CR A's receivable control. */
async function receiptJournal(pool: Pool, amount: number, bankAccount: string, date: string): Promise<string> {
  const ar = String((await pool.query("SELECT id FROM gl_accounts WHERE company_id = $1 AND account_subtype = 'receivable' AND is_system_account", [co.A])).rows[0].id);
  const id = (await pool.query(
    `INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id) VALUES ($1::date, 'Customer payment (planted)', 'auto_payment', 'draft', $2, $3) RETURNING id`,
    [date, U.ab, co.A])).rows[0].id as string;
  for (const [account, debit, credit] of [[bankAccount, amount, 0], [ar, 0, amount]] as const) {
    await pool.query('INSERT INTO gl_journal_lines(journal_entry_id, gl_account_id, debit, credit, company_id, description) VALUES ($1, $2, $3, $4, $5, $6)', [id, account, debit, credit, co.A, 'planted']);
  }
  await pool.query("UPDATE gl_journal_entries SET status = 'posted', posted_at = now() WHERE id = $1", [id]);
  return id;
}

/** A receipt of A for its customer of B (party.aCustomer): CONFIRMED on a posted journal unless `status` says otherwise; `alloc` its allocation rows. */
export async function plantReceipt(pool: Pool, over: {
  amount?: number; date?: string; status?: string; method?: string; client?: string; bankReference?: string | null; createdBy?: string;
  alloc?: { invoice: string; amount: number }[]; bankAccount?: string;
} = {}): Promise<string> {
  const amount = over.amount ?? 1150;
  const status = over.status ?? 'confirmed';
  const date = over.date ?? '2026-09-02';
  const je = status === 'draft' ? null : await receiptJournal(pool, amount, over.bankAccount ?? rbank.a, date);
  const id = (await pool.query(
    `INSERT INTO customer_payments(company_id, client_id, payment_date, total_amount, payment_method, bank_reference, bank_account_id, description, status,
       gl_journal_entry_id, created_by, confirmed_by, confirmed_at)
     VALUES ($1, $2, $3::date, $4, $5, $6, $7, 'IC planted receipt', $8, $9, $10, $11, $12) RETURNING id`,
    [co.A, over.client ?? party.aCustomer, date, amount, over.method ?? 'eft', over.bankReference ?? null, over.bankAccount ?? rbank.a, status, je,
      over.createdBy ?? U.ab, status === 'draft' ? null : U.ab, status === 'draft' ? null : new Date()])).rows[0].id as string;
  for (const a of over.alloc ?? []) {
    await pool.query('INSERT INTO customer_payment_allocations(payment_id, invoice_id, amount_allocated) VALUES ($1, $2, $3)', [id, a.invoice, a.amount]);
  }
  return id;
}

/** Everything a payment test planted in A (receipts and their journals), so the next test starts from nothing. */
export async function clearReceipts(pool: Pool): Promise<void> {
  await pool.query('DELETE FROM customer_payment_allocations WHERE payment_id IN (SELECT id FROM customer_payments WHERE company_id = ANY($1))', [[co.A, co.B, co.C]]);
  await pool.query('UPDATE customer_payments SET gl_journal_entry_id = NULL WHERE company_id = ANY($1)', [[co.A, co.B, co.C]]);
  await pool.query('DELETE FROM customer_payments WHERE company_id = ANY($1)', [[co.A, co.B, co.C]]);
  await pool.query("UPDATE customer_invoices SET amount_paid = 0, status = 'approved' WHERE company_id = $1 AND status IN ('paid', 'partially_paid')", [co.A]);
}

export interface DraftBody {
  outcome: 'draft'; bankAccountId: string; paymentDate: string; allocations: { invoiceId: string; amount: number }[];
  expected: { amount: number; state: string; invoiceIds: string[] };
}
export interface ExistingBody { outcome: 'existing'; receiptId: string; expected: { amount: number; state: string } }

export const draftBody = (s: { invoice: string; amount: number }, over: Partial<DraftBody> = {}, offered?: string[]): DraftBody => ({
  outcome: 'draft', bankAccountId: rbank.a, paymentDate: '2026-09-02', allocations: [{ invoiceId: s.invoice, amount: s.amount }],
  expected: { amount: s.amount, state: 'open', invoiceIds: offered ?? [s.invoice] }, ...over,
});
export const existingBody = (s: { amount: number }, receiptId: string, over: Partial<ExistingBody> = {}): ExistingBody => ({
  outcome: 'existing', receiptId, expected: { amount: s.amount, state: 'open' }, ...over,
});

const base = '/api/accounting/intercompany/payments';
export const payApi = {
  list: (user: string, company: string, query: Record<string, string> = {}) => callRoute(paymentsRoute, tokens[user]!, company, 'GET', undefined, base, query),
  get: (user: string, company: string, id: string) => callRoute(paymentRoute, tokens[user]!, company, 'GET', undefined, `${base}/${id}`, { id }),
  accept: (user: string, company: string, id: string, body: unknown) => callRoute(acceptRoute, tokens[user]!, company, 'POST', body, `${base}/${id}/accept`, { id }),
  discard: (user: string, company: string, id: string, body: unknown) => callRoute(discardRoute, tokens[user]!, company, 'POST', body, `${base}/${id}/discard-draft`, { id }),
  reject: (user: string, company: string, id: string, body: unknown) => callRoute(rejectRoute, tokens[user]!, company, 'POST', body, `${base}/${id}/reject`, { id }),
  dismiss: (user: string, company: string, id: string) => callRoute(dismissRoute, tokens[user]!, company, 'POST', undefined, `${base}/${id}/dismiss`, { id }),
  restore: (user: string, company: string, id: string) => callRoute(restoreRoute, tokens[user]!, company, 'POST', undefined, `${base}/${id}/restore`, { id }),
  unsent: (user: string, company: string) => callRoute(unsentRoute, tokens[user]!, company, 'GET', undefined, `${base}/unsent`),
  receiptState: (user: string, company: string, receiptId: string) => callRoute(receiptStateRoute, tokens[user]!, company, 'GET', undefined, `${base}/receipt-state`, { receiptId }),
  confirmReceipt: (user: string, company: string, paymentId: string) =>
    callRoute(receiptActionRoute, tokens[user]!, company, 'POST', { action: 'confirm', paymentId }, '/api/accounting/customer-payments-action'),
};

/** The invoice ids the detail offers A for this message (what the person saw: the `expected.invoiceIds` of a draft). */
export async function offeredOf(message: string): Promise<string[]> {
  const res = await payApi.get(U.a, co.A, message);
  const d = dataOf<{ suggestions: { invoices: { id: string }[] } | null }>(res);
  return d.suggestions?.invoices.map((i) => i.id) ?? [];
}

export const errorText = (r: { state: { statusCode: number; body: unknown } }) => `${r.state.statusCode} ${JSON.stringify(r.state.body).slice(0, 400)}`;
export { dataOf, acct, bank };

/** The ledger and rows as the cases judge them. */
export const rows = {
  journals: async (pool: Pool, company: string) => Number((await pool.query('SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id = $1', [company])).rows[0].n),
  receipts: async (pool: Pool, company = co.A) => (await pool.query(
    'SELECT id, status, total_amount::float8 AS total, bank_reference, payment_method, bank_account_id, payment_date::text AS date, created_by FROM customer_payments WHERE company_id = $1 ORDER BY created_at', [company])).rows,
  allocations: async (pool: Pool, receipt: string) => (await pool.query(
    'SELECT invoice_id, amount_allocated::float8 AS amount FROM customer_payment_allocations WHERE payment_id = $1 ORDER BY invoice_id', [receipt])).rows,
  message: async (pool: Pool, id: string) => (await pool.query(
    'SELECT status, target_doc_type, target_doc_id, handled_by, handled_at, handled_via, manual_only, reason, error, updated_at FROM intercompany_messages WHERE id = $1', [id])).rows[0],
  open: async (pool: Pool, invoice: string) => Number((await pool.query('SELECT (total_amount - COALESCE(amount_paid, 0))::float8 AS o FROM customer_invoices WHERE id = $1', [invoice])).rows[0].o),
};

/** A session held open (BEGIN, app_user, claims, company): the caller runs statements and commits / rolls back itself. */
export async function openSession(pool: Pool, user: string, company: string, role: 'app_user' | null = 'app_user'): Promise<PoolClient> {
  const q = await pool.connect();
  await q.query('BEGIN');
  if (role) await q.query(`SET LOCAL ROLE ${role}`);
  await q.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user })]);
  await q.query("SELECT set_config('app.current_company_id', $1, true)", [company]);
  return q;
}

/** The payer journal key D1 / D3 take first (1027's cap-lock key on the payment journal's chain root). */
export const journalKey = (payer: string, journal: string) => `SELECT pg_advisory_xact_lock(hashtextextended('${payer}' || ':journal:' || '${journal}', 1027))`;

/** Resolves once another backend of this database waits on a lock whose query matches `like` (bounded poll, not a sleep the outcome depends on). */
export async function blockedOn(pool: Pool, like: string, settled?: Promise<unknown>): Promise<void> {
  let early: { error?: unknown } | null = null;
  if (settled) void settled.then(() => { early = {}; }, (error: unknown) => { early = { error }; });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (early) throw (early as { error?: unknown }).error ?? new Error(`the statement (${like}) answered without waiting`);
    const r = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1", [`%${like}%`]);
    if ((r.rowCount ?? 0) > 0) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`no session waited on a lock for ${like}`);
}

export { co, U, party };
