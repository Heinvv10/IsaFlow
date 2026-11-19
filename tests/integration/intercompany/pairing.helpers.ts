/** Rows the pairing (P3) suites plant: open invoices with a number, date and amounts, and posted loan-account journals. */
import type { Pool } from 'pg';
import pairingRoute from '../../../pages/api/accounting/intercompany/connections/[id]/pairing';
import pairingLinkRoute from '../../../pages/api/accounting/intercompany/connections/[id]/pairing/links/[linkId]';
import { callRoute } from '../r035-approval.helpers';
import { U, co, invoices, party, tokens } from './intercompany.fixture';
import { asAppUser, plantConnection, plantSide, wipeConnections } from './intercompany.helpers';

export interface InvoiceOver {
  number?: string;
  date?: string;
  total?: number;
  paid?: number;
  status?: string;
  currency?: string;
  deleted?: boolean;
}

const journals: string[] = [];

const base = (id: string) => `/api/accounting/intercompany/connections/${id}/pairing`;
/** The pairing routes called as `user` acting for `company`, with real signed tokens and the real wrappers. */
export const pairingApi = {
  view: (user: string, company: string, id: string, direction = 'ar') =>
    callRoute(pairingRoute, tokens[user]!, company, 'GET', undefined, `${base(id)}?direction=${direction}`, { id, direction }),
  pair: (user: string, company: string, id: string, pairs: { mineId: string; theirsId: string }[], direction = 'ar') =>
    callRoute(pairingRoute, tokens[user]!, company, 'POST', { direction, pairs }, base(id), { id }),
  confirm: (user: string, company: string, id: string, linkId: string) =>
    callRoute(pairingLinkRoute, tokens[user]!, company, 'PUT', undefined, `${base(id)}/links/${linkId}`, { id, linkId }),
  unlink: (user: string, company: string, id: string, linkId: string) =>
    callRoute(pairingLinkRoute, tokens[user]!, company, 'DELETE', undefined, `${base(id)}/links/${linkId}`, { id, linkId }),
};

/** A fresh A-B connection, both sides set up (customer and supplier; `loan` adds each side's loan account) with a cut-over date. */
export async function pairingConnection(pool: Pool, loan?: { a: string; b: string }, cutover: string | null = '2026-10-01'): Promise<string> {
  await wipeConnections(pool);
  await wipeDocuments(pool);
  const id = await plantConnection(pool, co.A, co.B);
  await plantSide(pool, id, co.A, co.B, { customer_id: party.aCustomer, supplier_id: party.aSupplier, ...(loan ? { loan_account_id: loan.a } : {}) });
  await plantSide(pool, id, co.B, co.A, { customer_id: party.bCustomer, supplier_id: party.bSupplier, ...(loan ? { loan_account_id: loan.b } : {}) });
  if (cutover) await asAppUser(pool, U.ab, co.A, (q) => q.query('UPDATE intercompany_connections SET cutover_date = $2 WHERE id = $1', [id, cutover]), true);
  return id;
}

/** A second account of `company` for the other leg of a planted journal (the fixture's accounts are all liabilities of A, bar one). */
export async function plantBalancingAccount(pool: Pool, company: string): Promise<string> {
  const id = crypto.randomUUID();
  const code = `ICB${id.slice(0, 5)}`;
  await pool.query(
    `INSERT INTO gl_accounts(id, company_id, account_code, account_name, account_type, normal_balance, is_active)
     VALUES ($1, $2, $3, $3, 'asset', 'debit', true)`, [id, company, code]);
  return id;
}

/** A customer invoice of `company` for `party` (the connection's customer), open by default. Returns its id. */
export async function plantCustomerInvoice(pool: Pool, company: string, party: string, over: InvoiceOver = {}): Promise<string> {
  const id = crypto.randomUUID();
  const total = over.total ?? 1150;
  await pool.query(
    `INSERT INTO customer_invoices(id, company_id, invoice_number, customer_id, client_id, invoice_date, due_date, subtotal, tax_rate, tax_amount,
       total_amount, amount_paid, currency_code, exchange_rate, status, created_by, deleted_at)
     VALUES ($1, $2, $3, $4, $4, $5, $5, $6, 15, 0, $7, $8, $9, 1, $10, $11, $12)`,
    [id, company, over.number ?? `INV-${id.slice(0, 6)}`, party, over.date ?? '2026-08-15', total / 1.15, total, over.paid ?? 0,
      over.currency ?? 'ZAR', over.status ?? 'approved', U.ab, over.deleted ? new Date() : null]);
  invoices.cust.push(id);
  return id;
}

/** A supplier invoice (a bill) of `company` from `party` (the connection's supplier), open by default. Returns its id. */
export async function plantSupplierInvoice(pool: Pool, company: string, party: string, over: InvoiceOver = {}): Promise<string> {
  const id = crypto.randomUUID();
  const total = over.total ?? 1150;
  await pool.query(
    `INSERT INTO supplier_invoices(id, company_id, invoice_number, supplier_id, invoice_date, due_date, subtotal, tax_rate, tax_amount,
       total_amount, amount_paid, currency, currency_code, exchange_rate, status, created_by, deleted_at)
     VALUES ($1, $2, $3, $4, $5, $5, $6, 15, 0, $7, $8, $9, $9, 1, $10, $11, $12)`,
    [id, company, over.number ?? `INV-${id.slice(0, 6)}`, party, over.date ?? '2026-08-15', total / 1.15, total, over.paid ?? 0,
      over.currency ?? 'ZAR', over.status ?? 'approved', U.ab, over.deleted ? new Date() : null]);
  invoices.supp.push(id);
  return id;
}

/** A posted journal of `company` with one line on `account` (debit or credit) and a balancing line on `other`. */
export async function plantJournal(pool: Pool, company: string, date: string, account: string, other: string, debit: number, credit: number, status = 'posted', source = 'manual'): Promise<void> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_journal_entries(id, company_id, entry_date, description, source, status, created_by)
     VALUES ($1, $2, $3, 'IC pairing test', $5, 'draft', $4)`, [id, company, date, U.ab, source]);
  await pool.query(
    `INSERT INTO gl_journal_lines(journal_entry_id, company_id, gl_account_id, debit, credit) VALUES ($1, $2, $3, $5, $6), ($1, $2, $4, $6, $5)`,
    [id, company, account, other, debit, credit]);
  if (status !== 'draft') await pool.query('UPDATE gl_journal_entries SET status = $2 WHERE id = $1', [id, status]);
  journals.push(id);
}

/** Every planted journal (and the rows under it) out, with triggers off for the statement's session: journals are append-only. */
export async function dropJournals(pool: Pool): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL session_replication_role = 'replica'");
    await c.query('DELETE FROM gl_journal_lines WHERE journal_entry_id = ANY($1)', [journals]);
    await c.query('DELETE FROM gl_journal_entries WHERE id = ANY($1)', [journals]);
    await c.query('COMMIT');
    journals.length = 0;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

/** Every invoice and journal a test planted, out, so the next test starts with an empty ledger on both sides. */
export async function wipeDocuments(pool: Pool): Promise<void> {
  await pool.query('DELETE FROM customer_invoices WHERE id = ANY($1)', [invoices.cust]);
  await pool.query('DELETE FROM supplier_invoices WHERE id = ANY($1)', [invoices.supp]);
  invoices.cust.length = 0;
  invoices.supp.length = 0;
  await dropJournals(pool);
}
