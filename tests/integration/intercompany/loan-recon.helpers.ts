/**
 * Fixture for the intercompany P5 (loan reconciliation, read only) suites, on top of P4-E's (which stands on P4-D's): B is the PAYER, A the
 * RECEIVER, on the GROUP LOAN connection A <-> B (pair cut-over 2026-01-01). Every test gets FRESH loan accounts on both sides (acct.aLoan /
 * acct.bLoan re-pointed before the connection is planted), so a balance is exactly what that test posted: a posted journal is never deleted.
 * Messages are made through the real paths where the plan asks for them (E's clearing route, D's accept route, the receipt's cancel service,
 * the sender definer), and by fixture where it says so (a pre-gate payer void, a bank-paid payment, a batch journal, a forged state).
 */
import type { Pool } from 'pg';
import reconListRoute from '../../../pages/api/accounting/intercompany/loan-reconciliation';
import reconRoute from '../../../pages/api/accounting/intercompany/loan-reconciliation/[connectionId]';
import { cancelCustomerPayment } from '../../../src/modules/accounting/services/ar/customerPaymentService';
import { loadReconRows } from '../../../src/modules/accounting/services/intercompany/loanReconService';
import type { ReconItem, ReconReport, ReconSummary } from '../../../src/modules/accounting/services/intercompany/loanReconTypes';
import { callRoute } from '../r035-approval.helpers';
import { acct, asAppUser, co, party, tokens, U, withoutTrigger } from './intercompany.helpers';
import { acc, asService, dataOf, plantArInvoice } from './mirror.helpers';
import { bank, linkBill, plantPaid, sendFor } from './allocation.helpers';
import { clearConnect, outcomeOf } from './allocation-clear.helpers';
import { asPerson, clearBill, clearBody, clearedOf, errorText, payable, payerSetup, receiverAccepts } from './payer-clear.helpers';

export { asPerson, errorText, payable };

/** P4-E's fixture, plus next year's fiscal period for both companies (the timing cases post a few days after today). */
export async function reconSetup(pool: Pool): Promise<void> {
  await payerSetup(pool);
  await pool.query(
    `INSERT INTO fiscal_periods(company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
     SELECT c, 'IC 2027', 1, 2027, DATE '2027-01-01', DATE '2027-12-31', 'open' FROM unnest($1::uuid[]) c`, [[co.A, co.B]]);
}

/** Today in Johannesburg plus `days`, as the database computes T. */
export const dayOf = async (pool: Pool, days = 0): Promise<string> =>
  String((await pool.query("SELECT to_char((now() AT TIME ZONE 'Africa/Johannesburg')::date + $1::int, 'YYYY-MM-DD') AS d", [days])).rows[0].d);

/** Fresh loan accounts for A (a loan-class asset) and B (a loan-class liability); the helpers read acct.aLoan / acct.bLoan when called. */
export async function freshLoans(pool: Pool): Promise<void> {
  const a = crypto.randomUUID();
  const b = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_accounts(id, company_id, account_code, account_name, account_type, normal_balance, is_active, account_subtype)
     VALUES ($1, $2, $3, 'P5 A loan', 'asset', 'debit', true, 'other_current_asset'),
            ($4, $5, $6, 'P5 B loan', 'liability', 'credit', true, 'other_current_liability')`,
    [a, co.A, `RLA${a.slice(0, 8)}`, b, co.B, `RLB${b.slice(0, 8)}`]);
  acct.aLoan = a;
  acct.bLoan = b;
}

/** Fresh loan accounts and the A <-> B group loan connection on them (both sides mirroring from the cut-over). */
export async function reconConnect(pool: Pool, over: Parameters<typeof clearConnect>[1] = {}): Promise<string> {
  await freshLoans(pool);
  return clearConnect(pool, over);
}

/** A posted journal of `company` dated `date` with `lines` [account, debit, credit]. */
export async function plantJournal(pool: Pool, company: string, date: string, lines: [string, number, number][], description = 'P5 planted'): Promise<string> {
  const id = (await pool.query(
    `INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id) VALUES ($1::date, $2, 'manual', 'draft', $3, $4) RETURNING id`,
    [date, description, U.ab, company])).rows[0].id as string;
  for (const [account, debit, credit] of lines) {
    await pool.query('INSERT INTO gl_journal_lines(journal_entry_id, gl_account_id, debit, credit, company_id, description) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, account, debit, credit, company, 'planted']);
  }
  await pool.query("UPDATE gl_journal_entries SET status = 'posted', posted_at = now() WHERE id = $1", [id]);
  return id;
}

/** The exact negation of `je`, posted on `date` and linked to it (the way the reversal service links one: after it is posted). */
export async function reverseOn(pool: Pool, je: string, date: string): Promise<string> {
  const id = (await pool.query(
    `INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id)
     SELECT $2::date, 'P5 reversal', source, 'draft', created_by, company_id FROM gl_journal_entries WHERE id = $1 RETURNING id`, [je, date])).rows[0].id as string;
  await pool.query(`INSERT INTO gl_journal_lines(journal_entry_id, gl_account_id, debit, credit, company_id, description)
                    SELECT $2, gl_account_id, credit, debit, company_id, 'P5 reversal' FROM gl_journal_lines WHERE journal_entry_id = $1`, [je, id]);
  await pool.query("UPDATE gl_journal_entries SET status = 'posted', posted_at = now() WHERE id = $1", [id]);
  await pool.query('UPDATE gl_journal_entries SET reversal_of_id = $2 WHERE id = $1', [id, je]);
  return id;
}

/** The hand-posted opening balances: B credits its loan account, A debits its own (0 = none). */
export async function opening(pool: Pool, b: number, a: number): Promise<void> {
  if (b) await plantJournal(pool, co.B, '2026-08-01', [[acc.bExp1, b, 0], [acct.bLoan, 0, b]], 'P5 opening');
  if (a) await plantJournal(pool, co.A, '2026-08-01', [[acct.aLoan, a, 0], [acct.aExpense, 0, a]], 'P5 opening');
}

/** B's approved bill of `amount` and A's approved invoice (one line of `amount` + VAT, so it is open for at least the amount), linked. */
export async function pair(pool: Pool, conn: string, amount: number, over: { link?: boolean; date?: string; paid?: number } = {}) {
  const bill = crypto.randomUUID();
  await pool.query(
    `INSERT INTO supplier_invoices(id, company_id, invoice_number, supplier_id, invoice_date, due_date, subtotal, tax_rate, tax_amount, total_amount,
       amount_paid, currency, currency_code, exchange_rate, status, created_by)
     VALUES ($1, $2, $3, $4, $5::date, $5::date + 30, $6, 15, 0, $6, $7, 'ZAR', 'ZAR', 1, 'approved', $8)`,
    [bill, co.B, `P5B-${bill.slice(0, 8)}`, party.bSupplier, over.date ?? '2026-09-01', amount, over.paid ?? 0, U.ab]);
  const invoice = (await plantArInvoice(pool, { status: 'approved', lines: [['P5 recon', 1, amount]] })).id;
  const link = over.link === false ? null : await linkBill(pool, conn, invoice, bill);
  return { bill, invoice, link, amount };
}

export interface Paid { bill: string; invoice: string; link: string | null; amount: number; payment: string; journal: string; message: string }

/** E: B clears the bill against its loan account through the real route; the hook sends the message. */
export async function ePay(pool: Pool, conn: string, amount: number): Promise<Paid> {
  const p = await pair(pool, conn, amount);
  const res = await clearBill(clearBody(p, { amount, open: amount }));
  if (res.state.statusCode !== 200) throw new Error(`E refused: ${errorText(res)}`);
  const out = clearedOf(res);
  return { ...p, payment: out.paymentId, journal: out.journalEntryId, message: out.messageId };
}

/** D: A accepts the message (clears its invoice against its loan account). */
export async function accepted(m: Paid): Promise<{ receipt: string; journal: string }> {
  const res = await receiverAccepts(m.message, m.invoice, m.amount);
  const out = outcomeOf(res);
  if (!out.accepted) throw new Error(`D refused: ${errorText(res)}`);
  return { receipt: out.paymentId!, journal: out.journalEntryId! };
}

/** A cancels its clearing receipt (#1833: the payer's side stands). */
export const cancelReceipt = (pool: Pool, receipt: string) => asService(pool, U.a, co.A, () => cancelCustomerPayment(co.A, receipt, U.a, 'P5 receipt cancel'));

/** A payer void from before the undo gate existed (or a migration_admin edit): the journal reversed and the payment cancelled by fixture. */
export async function preGateVoid(pool: Pool, m: Paid): Promise<void> {
  await reverseOn(pool, m.journal, '2026-09-20');
  await pool.query("UPDATE supplier_payments SET status = 'cancelled' WHERE id = $1", [m.payment]);
}

/** A payment of B for its linked bill planted by fixture (credit `leg`: B's bank unless said), the message sent by the definer. */
export async function fixturePaid(pool: Pool, conn: string, amount: number, over: { leg?: string; journal?: string; send?: boolean; date?: string } = {}) {
  const p = await pair(pool, conn, amount);
  const paid = await plantPaid(pool, p.bill, { amount, leg: over.leg ?? bank.b, ...(over.journal ? { journal: over.journal } : {}), ...(over.date ? { date: over.date } : {}) });
  if (over.send === false) return { ...p, payment: paid.payment, allocation: paid.allocation, journal: paid.journal ?? over.journal ?? '', message: '' };
  const sent = await sendFor(pool, paid.allocation);
  if (!sent.message_id) throw new Error(`not sent: ${sent.reason}`);
  return { ...p, payment: paid.payment, allocation: paid.allocation, journal: paid.journal ?? over.journal ?? '', message: sent.message_id };
}

/** A message row changed by fixture (the messages guard off): a forged or back-dated state. */
export const forgeMessage = (pool: Pool, id: string, set: string, params: unknown[] = []) =>
  withoutTrigger(pool, 'intercompany_messages', 'trg_intercompany_messages_guard', (q) => q.query(`UPDATE intercompany_messages SET ${set} WHERE id = $1`, [id, ...params]));

/** A side row changed by fixture (the sides guard off). */
export const forgeSide = (pool: Pool, conn: string, company: string, set: string, params: unknown[] = []) =>
  withoutTrigger(pool, 'intercompany_connection_sides', 'trg_intercompany_sides_guard', (q) =>
    q.query(`UPDATE intercompany_connection_sides SET ${set} WHERE connection_id = $1 AND company_id = $2`, [conn, company, ...params]));

/** A connection row changed by fixture (the connections guard off). */
export const forgeConnection = (pool: Pool, conn: string, set: string) =>
  withoutTrigger(pool, 'intercompany_connections', 'trg_intercompany_connections_guard', (q) => q.query(`UPDATE intercompany_connections SET ${set} WHERE id = $1`, [conn]));

const URL = '/api/accounting/intercompany/loan-reconciliation';
export const reportAs = (user: string, company: string, conn: string, q: Record<string, string> = {}, token = tokens[user]!) =>
  callRoute(reconRoute, token, company, 'GET', undefined, `${URL}/${conn}${Object.keys(q).length ? `?${new URLSearchParams(q)}` : ''}`, { connectionId: conn, ...q });
export const listAs = (user: string, company: string, token = tokens[user]!) => callRoute(reconListRoute, token, company, 'GET', undefined, URL);
export const reportOf = (r: { state: { body: unknown } }) => dataOf<ReconReport>(r);
export const errorOf = (r: { state: { body: unknown } }) => (r.state.body as { error?: unknown }).error;

/** Every classified row (matched and in-flight included) and the summary, through the service as `user`'s own session of `company`; strict:
 *  an identity failure throws here (the service never reads the environment for it). */
export const rowsAs = (pool: Pool, user: string, company: string, conn: string) =>
  asPerson(pool, user, company, () => loadReconRows(company, conn, { strict: true })) as Promise<{ summary: ReconSummary; items: ReconItem[]; asOf: string; readAt: string }>;

/** The bucket of each message by id. */
export const bucketsOf = (rows: { items: ReconItem[] }) => Object.fromEntries(rows.items.filter((i) => i.kind === 'message').map((i) => [i.id, i.bucket]));
export const itemOf = (rows: { items: ReconItem[] }, id: string) => rows.items.find((i) => i.id === id);

/** The two definers called straight, as app_user in a session of `company` (what anyone holding app_user can do). */
export const rawMessages = (pool: Pool, user: string, company: string, conn: string) => asAppUser(pool, user, company,
  async (q) => (await q.query('SELECT * FROM public.intercompany_loan_recon_messages($1)', [conn])).rows as Record<string, unknown>[]);
export const rawSummary = (pool: Pool, user: string, company: string, conn: string) => asAppUser(pool, user, company,
  async (q) => (await q.query('SELECT * FROM public.intercompany_loan_recon_summary($1)', [conn])).rows as Record<string, unknown>[]);

/** The partner-fact columns of b3 per direction ((k).1); loan_account_changed is the OR of both sides' parts, the partner's NULL when withheld. */
export const PARTNER_FACTS = {
  in: ['payer_state', 'payer_after_t', 'payer_loan_credit', 'payer_counts', 'payer_journal_differs'],
  out: ['receiver_state', 'receiver_after_t', 'receiver_counts', 'receiver_journal_differs', 'partner_document'],
} as const;

/** Components by key, as { amount, count }. */
export const componentsOf = (s: ReconSummary) => Object.fromEntries((s.components ?? []).map((c) => [c.key, { amount: c.amount, count: c.count }]));

/**
 * Put `line` at the top of a plpgsql function's body (after its first BEGIN) for a test, e.g. a call counter or a sleep; returns the restore
 * (the original definition, executed as it was). The function keeps its owner, grants and volatility.
 */
export async function instrument(pool: Pool, signature: string, line: string): Promise<() => Promise<void>> {
  const def = String((await pool.query('SELECT pg_get_functiondef($1::regprocedure) AS d', [signature])).rows[0].d);
  const m = /\$function\$[\s\S]*?\bBEGIN\b/.exec(def);
  if (!m) throw new Error(`${signature} has no plpgsql BEGIN to instrument`);
  const at = m.index + m[0].length;
  await pool.query(`${def.slice(0, at)}\n  ${line}\n${def.slice(at)}`);
  return async () => { await pool.query(def); };
}
