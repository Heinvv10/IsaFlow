/**
 * Admin audit 2026-11-14, item 3.4 ("Sage commit posts into closed periods"):
 * BY DESIGN, pinned here. A Sage migration exists to land historical invoices on
 * their original dates, which usually sit in a closed fiscal period, so both
 * posting paths waive the closed-period guard (AR: postCustomerInvoiceToGL
 * `historicalImport`; AP: sageMigrationCommitService.commitAPInvoice). A FILED
 * VAT return is never waived: a document moving VAT into a locked VAT period
 * is refused before anything is written. Coordinator decision 2026-11-14 (a).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { als } from '@/lib/als';
import { commitAPInvoice, commitARInvoice } from '@/modules/admin/services/sageMigrationCommitService';
import { getPeriodStatusForDate } from '@/modules/accounting/services/gl/periodStatusService';
import { VatPeriodLockedError } from '@/modules/accounting/services/gl/journalVatLockGuard';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const companyId = randomUUID();
const userId = randomUUID();
const tag = companyId.slice(0, 8);
const CUSTOMER = `WP11 closed customer ${tag}`;
const SUPPLIER = `WP11 closed supplier ${tag}`;

/** As in production (withPlatformAdmin): inside a request transaction, committed. */
async function inRequestTx<T>(fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, userId, companyId, claims: {} } as never, fn);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const journal = async (table: 'customer_invoices' | 'supplier_invoices', number: string) => (await pool.query(
  `SELECT je.status, to_char(je.entry_date, 'YYYY-MM-DD') AS entry_date
     FROM ${table} d JOIN gl_journal_entries je ON je.id = d.gl_journal_entry_id
    WHERE d.company_id = $1 AND d.invoice_number = $2`, [companyId, number])).rows;
const documents = async (table: 'customer_invoices' | 'supplier_invoices', number: string) =>
  (await pool.query(`SELECT 1 FROM ${table} WHERE company_id = $1 AND invoice_number = $2`, [companyId, number])).rows.length;

const ar = (invoiceNumber: string, invoiceDate: string) => ({
  invoiceNumber, customerName: CUSTOMER, invoiceDate, subtotal: 1000, taxAmount: 150, totalAmount: 1150, amountPaid: 1150,
});
const ap = (invoiceNumber: string, invoiceDate: string) => ({
  invoiceNumber, supplierName: SUPPLIER, invoiceDate, subtotal: 100, taxAmount: 15, totalAmount: 115, amountPaid: 115,
});

beforeAll(async () => {
  await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [companyId, `WP11 closed ${tag}`]);
  await pool.query(`INSERT INTO users (id, email, role, is_active, account_type) VALUES ($1, $2, 'admin', true, 'direct')`,
    [userId, `${userId}@wp11closed.test.local`]);
  await pool.query('INSERT INTO customers (company_id, name, is_active) VALUES ($1, $2, true)', [companyId, CUSTOMER]);
  await pool.query('INSERT INTO suppliers (company_id, name) VALUES ($1, $2)', [companyId, SUPPLIER]);
  await pool.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active, is_system_account)
     VALUES ($1, '1100', 'AR', 'asset', 'receivable', 'debit', true, true),
            ($1, '4000', 'Revenue', 'revenue', 'default_revenue', 'credit', true, true),
            ($1, '2300', 'VAT Output', 'liability', 'vat_output', 'credit', true, true),
            ($1, '2100', 'AP', 'liability', 'payable', 'credit', true, true),
            ($1, '1140', 'VAT Input', 'asset', 'vat_input', 'debit', true, true),
            ($1, '6000', 'Expense', 'expense', 'default_expense', 'debit', true, true)`, [companyId]);
  await pool.query(
    `INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
     VALUES ($1, 'FY25', 1, 2025, '2025-01-01', '2025-12-31', 'closed'),
            ($1, 'FY26', 1, 2026, '2026-01-01', '2026-12-31', 'open')`, [companyId]);
  await pool.query(
    `INSERT INTO vat_period_locks (company_id, period_start, period_end, output_tax, input_tax, net_vat, posted_through, locked_by)
     VALUES ($1, '2025-05-01', '2025-06-30', 0, 0, 0, '2025-06-30', $2)`, [companyId, userId]);
  clearSystemAccountCache(companyId);
}, 60000);

afterAll(async () => {
  try {
    clearSystemAccountCache(companyId);
    const c = [companyId];
    await pool.query('UPDATE customer_invoices SET gl_journal_entry_id = NULL WHERE company_id = $1', c);
    await pool.query('UPDATE supplier_invoices SET gl_journal_entry_id = NULL WHERE company_id = $1', c);
    await pool.query('DELETE FROM customer_invoice_items WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id = $1)', c);
    await pool.query('DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id = $1)', c);
    await pool.query('DELETE FROM customer_invoices WHERE company_id = $1', c);
    await pool.query('DELETE FROM supplier_invoices WHERE company_id = $1', c);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id = $1', c);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id = $1', c);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = $1)', c);
    await pool.query('DELETE FROM gl_accounts WHERE company_id = $1', c);
    await pool.query('DELETE FROM vat_period_locks WHERE company_id = $1', c);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id = $1', c);
    await pool.query('DELETE FROM customers WHERE company_id = $1', c);
    await pool.query('DELETE FROM suppliers WHERE company_id = $1', c);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.query('DELETE FROM companies WHERE id = $1', c);
  } finally { await pool.end(); }
}, 60000);

describe('Sage commit: closed fiscal periods are waived, filed VAT periods are not', () => {
  it('the fixture period really is closed', async () => {
    expect(await getPeriodStatusForDate(companyId, '2025-03-10')).toBe('closed');
  });

  it('posts a historical customer and supplier invoice on their original date in a closed period', async () => {
    const arOut = await inRequestTx(() => commitARInvoice(companyId, userId, ar(`AR-CLOSED-${tag}`, '2025-03-10')));
    const apOut = await inRequestTx(() => commitAPInvoice(companyId, userId, ap(`AP-CLOSED-${tag}`, '2025-03-11')));
    expect([arOut.created, apOut.created]).toEqual([true, true]);
    expect(await journal('customer_invoices', `AR-CLOSED-${tag}`)).toEqual([{ status: 'posted', entry_date: '2025-03-10' }]);
    expect(await journal('supplier_invoices', `AP-CLOSED-${tag}`)).toEqual([{ status: 'posted', entry_date: '2025-03-11' }]);
  });

  it('refuses a customer invoice moving VAT into a filed VAT period, writing nothing', async () => {
    const err = await inRequestTx(() => commitARInvoice(companyId, userId, ar(`AR-FILED-${tag}`, '2025-06-05')))
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(VatPeriodLockedError);
    expect(await documents('customer_invoices', `AR-FILED-${tag}`)).toBe(0);
  });

  it('refuses a supplier invoice moving VAT into a filed VAT period, writing nothing', async () => {
    const err = await inRequestTx(() => commitAPInvoice(companyId, userId, ap(`AP-FILED-${tag}`, '2025-06-05')))
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(VatPeriodLockedError);
    expect(await documents('supplier_invoices', `AP-FILED-${tag}`)).toBe(0);
  });
});
