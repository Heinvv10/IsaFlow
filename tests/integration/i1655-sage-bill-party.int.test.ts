/**
 * #1655 review L4: once two Sage parties of the same name each have their own row
 * (sagePartyMatch), a Sage bill or invoice must land on the party Sage names by id
 * (SupplierId / CustomerId), not on the first row of that name. Through the real
 * commitAPInvoice / commitARInvoice on a throwaway cluster, in a committed request
 * transaction as withPlatformAdmin runs them; the stored party is read back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { als } from '@/lib/als';
import { commitAPInvoice, commitARInvoice } from '@/modules/admin/services/sageMigrationCommitService';
import { commitSageMigration } from '@/modules/admin/services/sageMigrationOrchestrator';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const companyId = randomUUID();
const userId = randomUUID();
const tag = companyId.slice(0, 8);

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

const party = (sageId: number, name: string) => ({ name, sageId, email: '', phone: '', vatNumber: '', contactPerson: '' });
const idOf = async (table: 'suppliers' | 'customers', ref: string) => String((await pool.query(
  `SELECT id FROM ${table} WHERE company_id = $1 AND external_system = 'sage' AND external_ref = $2 AND deleted_at IS NULL`,
  [companyId, ref])).rows[0].id);

beforeAll(async () => {
  await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [companyId, `i1655 bills ${tag}`]);
  await pool.query(`INSERT INTO users (id, email, role, is_active, account_type) VALUES ($1, $2, 'admin', true, 'direct')`,
    [userId, `${userId}@i1655.test.local`]);
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
     VALUES ($1, 'FY26', 1, 2026, '2026-01-01', '2026-12-31', 'open')`, [companyId]);
  clearSystemAccountCache(companyId);
  // Two Sage suppliers and two Sage customers whose names differ only in case: each gets its own row.
  // 601/701 commit first, in their own transaction, so they are the EARLIER rows: a name-only lookup
  // (ordered by created_at) picks them, and a bill that ignored Sage's id would land there, not by chance.
  for (const [s, c] of [[party(601, 'Fox Traders'), party(701, 'Gull Stores')], [party(602, 'FOX TRADERS'), party(702, 'GULL STORES')]]) {
    await inRequestTx(() => commitSageMigration({
      companyId, userId, pulled: { suppliers: { records: [s!] }, customers: { records: [c!] } },
    }));
  }
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
    await pool.query('DELETE FROM fiscal_periods WHERE company_id = $1', c);
    await pool.query('DELETE FROM customers WHERE company_id = $1', c);
    await pool.query('DELETE FROM suppliers WHERE company_id = $1', c);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.query('DELETE FROM companies WHERE id = $1', c);
  } finally { await pool.end(); }
}, 60000);

describe('a Sage document lands on the party Sage names by id (#1655 L4)', () => {
  it('a bill for Sage supplier 602 lands on 602, not on the first "Fox Traders" row', async () => {
    const number = `AP-1655-${tag}`;
    const out = await inRequestTx(() => commitAPInvoice(companyId, userId, {
      invoiceNumber: number, supplierName: 'Fox Traders', supplierSageId: 602, invoiceDate: '2026-03-11',
      subtotal: 100, taxAmount: 15, totalAmount: 115, amountPaid: 115,
    }));
    expect(out.created).toBe(true);
    const { rows } = await pool.query('SELECT supplier_id FROM supplier_invoices WHERE company_id = $1 AND invoice_number = $2',
      [companyId, number]);
    expect(rows.map((r) => String(r.supplier_id))).toEqual([await idOf('suppliers', '602')]);
  });

  it('an invoice for Sage customer 702 lands on 702, not on the first "Gull Stores" row', async () => {
    const number = `AR-1655-${tag}`;
    const out = await inRequestTx(() => commitARInvoice(companyId, userId, {
      invoiceNumber: number, customerName: 'Gull Stores', customerSageId: 702, invoiceDate: '2026-03-10',
      subtotal: 1000, taxAmount: 150, totalAmount: 1150, amountPaid: 1150,
    }));
    expect(out.created).toBe(true);
    const { rows } = await pool.query(
      'SELECT COALESCE(client_id, customer_id) AS who FROM customer_invoices WHERE company_id = $1 AND invoice_number = $2',
      [companyId, number]);
    expect(rows.map((r) => String(r.who))).toEqual([await idOf('customers', '702')]);
  });

  it('an invoice matching a hand-keyed customer by name claims it, so a later same-name Sage customer gets its own row', async () => {
    const keyed = String((await pool.query(
      "INSERT INTO customers (company_id, name) VALUES ($1, 'Heron Foods') RETURNING id", [companyId])).rows[0].id);
    const number = `AR-1655-K-${tag}`;
    await inRequestTx(() => commitARInvoice(companyId, userId, {
      invoiceNumber: number, customerName: 'Heron Foods', customerSageId: 711, invoiceDate: '2026-03-12',
      subtotal: 100, taxAmount: 15, totalAmount: 115, amountPaid: 115,
    }));
    expect(await idOf('customers', '711')).toBe(keyed);
    await inRequestTx(() => commitSageMigration({
      companyId, userId, pulled: { customers: { records: [party(712, 'Heron Foods'), party(711, 'Heron Foods')] } },
    }));
    expect(await idOf('customers', '711')).toBe(keyed);
    expect(await idOf('customers', '712')).not.toBe(keyed);
    const { rows } = await pool.query(
      'SELECT COALESCE(client_id, customer_id) AS who FROM customer_invoices WHERE company_id = $1 AND invoice_number = $2',
      [companyId, number]);
    expect(rows.map((r) => String(r.who))).toEqual([keyed]);
  });
});
