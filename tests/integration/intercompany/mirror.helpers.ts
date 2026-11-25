/**
 * Fixture for the intercompany P2 (mirror) suites: the P1 fixture's three tenants (A and B in group G, C elsewhere) plus what
 * posting and receiving need: A can approve a customer invoice (a chart and an open year), B has expense accounts and a supplier,
 * and the connection A <-> B has its cut-over and both sides set. Services run as app_user inside a transaction with the user's
 * claims and the company's GUC, as `withAuth` opens a request; the real routes are called with real signed tokens.
 */
import type { Pool, PoolClient } from 'pg';
import { runOwnedContext } from '../../../src/lib/afterCommit';
import { clearSystemAccountCache } from '../../../src/modules/accounting/services/gl/systemAccountResolver';
import customerInvoicesDetail from '../../../pages/api/accounting/customer-invoices-detail';
import inboxRoute from '../../../pages/api/accounting/intercompany/inbox';
import inboxCountRoute from '../../../pages/api/accounting/intercompany/inbox-count';
import inboxItemRoute from '../../../pages/api/accounting/intercompany/inbox/[id]/index';
import acceptRoute from '../../../pages/api/accounting/intercompany/inbox/[id]/accept';
import rejectRoute from '../../../pages/api/accounting/intercompany/inbox/[id]/reject';
import dismissRoute from '../../../pages/api/accounting/intercompany/inbox/[id]/dismiss';
import restoreRoute from '../../../pages/api/accounting/intercompany/inbox/[id]/restore';
import { callRoute } from '../r035-approval.helpers';
import { cleanupPr4 } from '../r035-pr4.helpers';
import { acct, co, companies, party, setup, tokens, U, wipeConnections } from './intercompany.fixture';
import { asAppUser } from './intercompany.session';
import { plantConnection, plantSide } from './intercompany.plant';
import { dropFeatureOverrides } from './loan-clearing.helpers';

export { U, co, party, tokens, companies, wipeConnections };

export const acc = { bExp1: '', bExp2: '', bExpHeader: '', bExpChild: '' };

const CHART: [string, string, string, string][] = [
  ['RV', 'revenue', 'default_revenue', 'credit'], ['AR', 'asset', 'receivable', 'debit'], ['VO', 'liability', 'vat_output', 'credit'],
];

/** Everything the mirror suites stand on. Runs once per file, after the P1 fixture. */
export async function mirrorSetup(pool: Pool): Promise<void> {
  await setup(pool);
  const tag = co.A.slice(0, 6);
  for (const [code, type, subtype, normal] of CHART) {
    await pool.query(
      `INSERT INTO gl_accounts(company_id, account_code, account_name, account_type, normal_balance, is_active, is_system_account, account_subtype)
       VALUES ($1, $2, $3, $4, $5, true, true, $6)`, [co.A, `${code}${tag}`, `IC ${subtype}`, type, normal, subtype]);
  }
  await pool.query(
    `INSERT INTO fiscal_periods(company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
     VALUES ($1, 'IC 2026', 1, 2026, '2026-01-01', '2026-12-31', 'open')`, [co.A]);
  // B can approve a supplier invoice / credit note too (the receiver's approval is what matches the sender's group row)
  const tagB0 = co.B.slice(0, 6);
  await pool.query(
    `INSERT INTO gl_accounts(company_id, account_code, account_name, account_type, normal_balance, is_active, is_system_account, account_subtype)
     VALUES ($1, 'AP${tagB0}', 'IC AP', 'liability', 'credit', true, true, 'payable'),
            ($1, 'VI${tagB0}', 'IC VAT input', 'asset', 'debit', true, true, 'vat_input'),
            ($1, 'DE${tagB0}', 'IC default expense', 'expense', 'debit', true, true, 'default_expense')`, [co.B]);
  await pool.query(
    `INSERT INTO fiscal_periods(company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
     VALUES ($1, 'IC 2026', 1, 2026, '2026-01-01', '2026-12-31', 'open')`, [co.B]);
  clearSystemAccountCache(co.A);
  clearSystemAccountCache(co.B);
  for (const k of Object.keys(acc) as (keyof typeof acc)[]) acc[k] = crypto.randomUUID();
  const tagB = co.B.slice(0, 5);
  const expense = (id: string, code: string, parent: string | null = null) => pool.query(
    `INSERT INTO gl_accounts(id, company_id, account_code, account_name, account_type, normal_balance, parent_account_id, is_active)
     VALUES ($1, $2, $3, $3, 'expense', 'debit', $4, true)`, [id, co.B, `ICX${code}${tagB}`, parent]);
  await expense(acc.bExpHeader, 'H');
  await expense(acc.bExpChild, 'C', acc.bExpHeader);
  await expense(acc.bExp1, '1');
  await expense(acc.bExp2, '2');
}

/** Both companies' tables the suites wrote to, then the shared cleanup (it also ends the pool). */
export async function mirrorCleanup(pool: Pool): Promise<void> {
  const both = [co.A, co.B, co.C];
  const quiet = async (text: string, params: unknown[]) => {
    try { await pool.query(text, params); } catch (err) { process.stderr.write(`mirror cleanup: ${text}: ${String(err)}\n`); }
  };
  await wipeConnections(pool).catch((err: unknown) => process.stderr.write(`mirror cleanup wipe: ${String(err)}\n`));
  await quiet('DELETE FROM intercompany_transactions WHERE group_id = ANY($1)', [[co.G, co.H]]);
  await quiet('DELETE FROM credit_note_allocations WHERE company_id = ANY($1)', [both]);
  await quiet('DELETE FROM captured_documents WHERE company_id = ANY($1)', [both]);
  await quiet('DELETE FROM audit_log WHERE company_id = ANY($1)', [both]);
  await quiet('UPDATE gl_accounts SET parent_account_id = NULL WHERE company_id = ANY($1)', [both]);
  await quiet('DELETE FROM cost_centres WHERE company_id = ANY($1)', [both]);
  await quiet('DELETE FROM business_units WHERE company_id = ANY($1)', [both]);
  await quiet('DELETE FROM company_group_members WHERE group_id = ANY($1)', [[co.G, co.H]]);
  await quiet('DELETE FROM company_groups WHERE id = ANY($1)', [[co.G, co.H]]);
  await dropFeatureOverrides(pool, companies).catch((err: unknown) => process.stderr.write(`mirror cleanup overrides: ${String(err)}\n`));
  await cleanupPr4(pool, companies, Object.values(U));
}

/** The connection A <-> B: cut-over 2026-01-01, A's customer and B's supplier and default expense account set. */
export async function connect(pool: Pool, over: { cutover?: string | null; autoAccept?: boolean; bSupplier?: boolean; bDefault?: boolean } = {}): Promise<string> {
  const id = await plantConnection(pool, co.A, co.B);
  const cutover = over.cutover === undefined ? '2026-01-01' : over.cutover;
  if (cutover) {
    await asAppUser(pool, U.ab, co.A, (q) => q.query('UPDATE intercompany_connections SET cutover_date = $2 WHERE id = $1', [id, cutover]), true);
  }
  await plantSide(pool, id, co.A, co.B, { customer_id: party.aCustomer });
  await plantSide(pool, id, co.B, co.A, {
    ...(over.bSupplier === false ? {} : { supplier_id: party.bSupplier }),
    ...(over.bDefault === false ? {} : { default_expense_account_id: acc.bExp1 }),
    ...(over.autoAccept ? { auto_accept: true } : {}),
  });
  return id;
}

/** A posted journal of `company` with no lines (the approval journal of a planted APPROVED document: the database sends only documents that are in the ledger). */
export async function plantPostedJournal(
  pool: Pool, company: string, description: string, source = 'auto_invoice',
  fig: { total: number; subtotal: number; tax: number; credit?: boolean } = { total: 1, subtotal: 1, tax: 0 }, date = '2026-09-01',
): Promise<string> {
  const id = (await pool.query(
    `INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id) VALUES ($5::date, $1, $2, 'draft', $3, $4) RETURNING id`,
    [description, source, U.ab, company, date])).rows[0].id as string;
  // The lines the real approval writes (receivable = gross, revenue = net, output VAT), a credit note's with the sides swapped: the database
  // sends a document only when its journal carries its figures, and the journal can be REVERSED like any posted one.
  const acct = async (subtype: string) => (await pool.query('SELECT id FROM gl_accounts WHERE company_id = $1 AND account_subtype = $2 LIMIT 1', [company, subtype])).rows[0].id as string;
  const [ar, rv, vat] = [await acct('receivable'), await acct('default_revenue'), await acct('vat_output')];
  const line = (account: string, debit: number, credit: number) => pool.query(
    'INSERT INTO gl_journal_lines(journal_entry_id, gl_account_id, debit, credit, company_id, description) VALUES ($1, $2, $3, $4, $5, $6)', [id, account, debit, credit, company, 'planted']);
  const d = (n: number) => (fig.credit ? 0 : n);
  const c = (n: number) => (fig.credit ? n : 0);
  await line(ar, d(fig.total), c(fig.total));
  await line(rv, c(fig.subtotal), d(fig.subtotal));
  if (fig.tax > 0) await line(vat, c(fig.tax), d(fig.tax));
  await pool.query("UPDATE gl_journal_entries SET status = 'posted', posted_at = now() WHERE id = $1", [id]);
  return id;
}

/**
 * A reversal of `je` written straight into the ledger as a fixture (no service, so no hook): a POSTED entry linked by reversal_of_id whose lines are
 * the exact negation of the original's. (A link without the negated lines is no reversal to the mirror: the chain is judged by value.) Linked the
 * way the reversal service links one, AFTER it is posted (1018 refuses an INSERT that carries reversal_of_id).
 */
export async function rawReverseJournal(pool: Pool, je: string, description = 'raw reversal'): Promise<string> {
  const id = (await pool.query(
    `INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id)
     SELECT entry_date, $2, source, 'draft', created_by, company_id FROM gl_journal_entries WHERE id = $1 RETURNING id`, [je, description])).rows[0].id as string;
  await pool.query(
    `INSERT INTO gl_journal_lines(journal_entry_id, gl_account_id, debit, credit, company_id, description)
     SELECT $2, gl_account_id, credit, debit, company_id, 'raw reversal' FROM gl_journal_lines WHERE journal_entry_id = $1`, [je, id]);
  await pool.query("UPDATE gl_journal_entries SET status = 'posted', posted_at = now() WHERE id = $1", [id]);
  await pool.query('UPDATE gl_journal_entries SET reversal_of_id = $2 WHERE id = $1', [id, je]);
  return id;
}

/** The posted reversal of `je`, if one is linked to it. */
export const reversalOf = async (pool: Pool, je: string): Promise<string | undefined> =>
  (await pool.query("SELECT id FROM gl_journal_entries WHERE reversal_of_id = $1 AND status = 'posted' ORDER BY created_at LIMIT 1", [je])).rows[0]?.id as string | undefined;

/** A customer credit note of A set to approved the way a fixture does, with its approval journal (posted, standing). */
export async function approveCreditNoteRow(pool: Pool, id: string): Promise<void> {
  const cn = (await pool.query('SELECT credit_note_number AS n, subtotal, tax_amount, total_amount FROM credit_notes WHERE id = $1', [id])).rows[0];
  const je = await plantPostedJournal(pool, co.A, `Credit note ${cn.n}`, 'auto_credit_note',
    { total: Number(cn.total_amount), subtotal: Number(cn.subtotal), tax: Number(cn.tax_amount ?? 0), credit: true });
  await pool.query("UPDATE credit_notes SET status = 'approved', gl_journal_entry_id = $2 WHERE id = $1", [id, je]);
}

export interface PlantedInvoice { id: string; number: string }

/** A customer invoice of A for A's linked customer (a DRAFT unless `status` says otherwise; an approved one carries a posted approval journal): two lines (R600 + R400) and 15% VAT, R1 150 in all. */
export async function plantArInvoice(pool: Pool, over: { date?: string; customer?: string; lines?: [string, number, number][]; currency?: string; status?: string; journalDate?: string } = {}): Promise<PlantedInvoice> {
  const id = crypto.randomUUID();
  const number = `ICAR-${id.slice(0, 8)}`;
  const lines = over.lines ?? [['Fibre install', 2, 300], ['Router', 1, 400]];
  const subtotal = lines.reduce((s, [, q, p]) => s + q * p, 0);
  const tax = Math.round(subtotal * 15) / 100;
  const customer = over.customer ?? party.aCustomer;
  const journal = over.status && over.status !== 'draft' ? await plantPostedJournal(pool, co.A, `Customer invoice ${number}`, 'auto_invoice', { total: subtotal + tax, subtotal, tax }, over.journalDate ?? '2026-09-01') : null;
  await pool.query(
    `INSERT INTO customer_invoices(id, company_id, invoice_number, customer_id, client_id, invoice_date, due_date, subtotal, tax_rate, tax_amount,
       total_amount, currency_code, exchange_rate, status, created_by, gl_journal_entry_id)
     VALUES ($1, $2, $3, $4, $4, $5::date, $5::date + 30, $6, 15, $7, $8, $9, 1, $10, $11, $12)`,
    [id, co.A, number, customer, over.date ?? '2026-09-01', subtotal, tax, subtotal + tax, over.currency ?? 'ZAR', over.status ?? 'draft', U.ab, journal]);
  for (const [description, quantity, unitPrice] of lines) {
    await pool.query(
      `INSERT INTO customer_invoice_items(invoice_id, description, quantity, unit_price, amount, tax_rate, currency_code)
       VALUES ($1, $2, $3, $4, $5, 15, $6)`, [id, description, quantity, unitPrice, quantity * unitPrice, over.currency ?? 'ZAR']);
  }
  return { id, number };
}

/** A DRAFT customer credit note of A for A's linked customer (R200 + R30 VAT). */
export async function plantArCreditNote(pool: Pool, over: { date?: string; customer?: string } = {}): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO credit_notes(id, company_id, credit_note_number, type, client_id, credit_date, reason, subtotal, tax_rate, tax_amount, total_amount, status, created_by)
     VALUES ($1, $2, $3, 'customer', $4, $5, 'Returned router', 200, 15, 30, 230, 'draft', $6)`,
    [id, co.A, `ICCN-${id.slice(0, 8)}`, over.customer ?? party.aCustomer, over.date ?? '2026-09-05', U.ab]);
  return id;
}

/** The real approve route, as `user` of A. */
export const approveInvoice = (id: string, user = U.a) =>
  callRoute(customerInvoicesDetail, tokens[user]!, co.A, 'POST', { action: 'approve', id }, '/api/accounting/customer-invoices-detail');

/** A service call as `user` acting as `company`: app_user, claims and GUC as withAuth opens them, one committed transaction. */
export async function asService<T>(pool: Pool, user: string, company: string, fn: (q: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user })]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [company]);
    const out = await runOwnedContext({ client, userId: user, companyId: company, claims: { sub: user }, afterCommit: [] }, () => fn(client));
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** An invoice approved in A through the real route: returns it and the message it left for B. */
export async function sentInvoice(pool: Pool, over: Parameters<typeof plantArInvoice>[1] = {}) {
  const inv = await plantArInvoice(pool, over);
  const res = await approveInvoice(inv.id);
  if (res.state.statusCode !== 200) throw new Error(`approve answered ${res.state.statusCode}: ${JSON.stringify(res.state.body)}`);
  const message = (await pool.query('SELECT * FROM intercompany_messages WHERE source_doc_id = $1', [inv.id])).rows[0];
  return { inv, id: message.id as string, message };
}

/** The pair's bills and messages, cleared (every mirror suite starts from nothing). */
export async function clearMirrorRows(pool: Pool): Promise<void> {
  await pool.query('DELETE FROM intercompany_transactions WHERE group_id = $1', [co.G]);
  await pool.query('DELETE FROM captured_documents WHERE company_id = ANY($1)', [[co.A, co.B, co.C]]);
  await pool.query('DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id = ANY($1))', [[co.A, co.B, co.C]]);
  await pool.query('DELETE FROM supplier_invoices WHERE company_id = ANY($1)', [[co.A, co.B, co.C]]);
  await pool.query("DELETE FROM credit_notes WHERE type = 'supplier' AND company_id = ANY($1)", [[co.A, co.B, co.C]]);
  await wipeConnections(pool);
}

const base = '/api/accounting/intercompany/inbox';
export const inbox = {
  count: (user: string, company: string) =>
    callRoute(inboxCountRoute, tokens[user]!, company, 'GET', undefined, `${base}-count`),
  list: (user: string, company: string, query: Record<string, string> = {}) =>
    callRoute(inboxRoute, tokens[user]!, company, 'GET', undefined, base, query),
  get: (user: string, company: string, id: string) =>
    callRoute(inboxItemRoute, tokens[user]!, company, 'GET', undefined, `${base}/${id}`, { id }),
  accept: (user: string, company: string, id: string, body?: unknown) =>
    callRoute(acceptRoute, tokens[user]!, company, 'POST', body, `${base}/${id}/accept`, { id }),
  reject: (user: string, company: string, id: string, body: unknown) =>
    callRoute(rejectRoute, tokens[user]!, company, 'POST', body, `${base}/${id}/reject`, { id }),
  dismiss: (user: string, company: string, id: string) =>
    callRoute(dismissRoute, tokens[user]!, company, 'POST', undefined, `${base}/${id}/dismiss`, { id }),
  restore: (user: string, company: string, id: string) =>
    callRoute(restoreRoute, tokens[user]!, company, 'POST', undefined, `${base}/${id}/restore`, { id }),
};

export const dataOf = <T = Record<string, unknown>>(r: { state: { body: unknown } }): T => (r.state.body as { data: T }).data;
export const errorOf = (r: { state: { body: unknown } }): string => (r.state.body as { error?: { message?: string } }).error?.message ?? '';

/** The one message from A to B for a source document, or undefined. */
export async function messageFor(pool: Pool, source: string): Promise<Record<string, unknown> | undefined> {
  return (await pool.query('SELECT * FROM intercompany_messages WHERE source_doc_id = $1', [source])).rows[0];
}

export { acct };

/** The group's chart for eliminations: group accounts for revenue and expense, mapped to A's default revenue and B's first expense account. */
export const groupAccounts = { rev: '', exp: '' };
export async function eliminationSetup(pool: Pool): Promise<void> {
  groupAccounts.rev = crypto.randomUUID();
  groupAccounts.exp = crypto.randomUUID();
  await pool.query(
    `INSERT INTO group_accounts(id, group_id, account_code, account_name, account_type) VALUES ($1, $3, 'G-REV', 'Group revenue', 'revenue'), ($2, $3, 'G-EXP', 'Group expense', 'expense')`,
    [groupAccounts.rev, groupAccounts.exp, co.G]);
  const aRev = (await pool.query("SELECT id FROM gl_accounts WHERE company_id = $1 AND account_subtype = 'default_revenue'", [co.A])).rows[0].id;
  await pool.query('INSERT INTO group_coa_mappings(group_id, group_account_id, company_id, company_account_id) VALUES ($1, $2, $3, $4), ($1, $5, $6, $7)',
    [co.G, groupAccounts.rev, co.A, aRev, groupAccounts.exp, co.B, acc.bExp1]);
}
export async function eliminationCleanup(pool: Pool): Promise<void> {
  for (const text of ['DELETE FROM consolidation_adjustments WHERE group_id = $1', 'DELETE FROM group_coa_mappings WHERE group_id = $1', 'DELETE FROM group_accounts WHERE group_id = $1']) {
    await pool.query(text, [co.G]).catch((err: unknown) => process.stderr.write(`elimination cleanup: ${text}: ${String(err)}\n`));
  }
}
