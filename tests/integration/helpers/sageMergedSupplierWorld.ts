/**
 * The shared world of the #1655 merged-supplier integration suites: one throwaway company with the accounts and
 * fiscal period the Sage AP import needs, and the helpers both suites use (a committed request transaction per call,
 * a Sage supplier sync, lookups by Sage id and by name, plain supplier seeding, a Sage bill).
 */
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { als } from '@/lib/als';
import { commitAPInvoice } from '@/modules/admin/services/sageMigrationCommitService';
import { commitSageMigration } from '@/modules/admin/services/sageMigrationOrchestrator';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';

export const party = (sageId: number | undefined, name: string) => ({ name, sageId, email: '', phone: '', vatNumber: '', contactPerson: '' });

export function sageMergedWorld(label: string) {
  const companyId = randomUUID();
  const userId = randomUUID();
  const tag = companyId.slice(0, 8);
  // application_name is this world's own: a probe of pg_stat_activity can tell its sessions from another suite's.
  const applicationName = `i1655-${label}-${tag}`;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4, application_name: applicationName });

  /** One committed request transaction; `asMember` also sets the session user's claims, as withAuth does (auth.uid() reads them). */
  async function inRequestTx<T>(fn: () => Promise<T>, asMember = false): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (asMember) await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId })]);
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

  const syncSuppliers = (records: ReturnType<typeof party>[]) =>
    inRequestTx(() => commitSageMigration({ companyId, userId, pulled: { suppliers: { records } } }));
  const byRef = async (ref: string) => (await pool.query(
    "SELECT id, deleted_at IS NOT NULL AS deleted, merged_into_id FROM suppliers WHERE company_id = $1 AND external_system = 'sage' AND external_ref = $2",
    [companyId, ref])).rows;
  const liveNamed = async (name: string) => (await pool.query(
    'SELECT id, external_ref FROM suppliers WHERE company_id = $1 AND deleted_at IS NULL AND lower(name) = lower($2) ORDER BY created_at',
    [companyId, name])).rows;
  const insPlain = async (name: string, system: string | null = null, ref: string | null = null) => String((await pool.query(
    'INSERT INTO suppliers (company_id, name, external_system, external_ref) VALUES ($1, $2, $3, $4) RETURNING id',
    [companyId, name, system, ref])).rows[0].id);
  const bill = (number: string, name: string, sageId: number) => inRequestTx(() => commitAPInvoice(companyId, userId, {
    invoiceNumber: `${number}-${tag}`, supplierName: name, supplierSageId: sageId, invoiceDate: '2026-04-02',
    subtotal: 100, taxAmount: 15, totalAmount: 115, amountPaid: 115,
  }));
  const billSupplier = async (number: string) => String((await pool.query(
    'SELECT supplier_id FROM supplier_invoices WHERE company_id = $1 AND invoice_number = $2', [companyId, `${number}-${tag}`])).rows[0].supplier_id);

  async function seed(): Promise<void> {
    await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [companyId, `i1655 ${label} ${tag}`]);
    await pool.query(`INSERT INTO users (id, email, role, is_active, account_type) VALUES ($1, $2, 'admin', true, 'direct')`,
      [userId, `${userId}@i1655m.test.local`]);
    await pool.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active, is_system_account)
       VALUES ($1, '2100', 'AP', 'liability', 'payable', 'credit', true, true),
              ($1, '1140', 'VAT Input', 'asset', 'vat_input', 'debit', true, true),
              ($1, '6000', 'Expense', 'expense', 'default_expense', 'debit', true, true)`, [companyId]);
    await pool.query(
      `INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
       VALUES ($1, 'FY26', 1, 2026, '2026-01-01', '2026-12-31', 'open')`, [companyId]);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner')", [companyId, userId]);
    clearSystemAccountCache(companyId);
  }

  async function drop(): Promise<void> {
    try {
      clearSystemAccountCache(companyId);
      const c = [companyId];
      await pool.query('DELETE FROM intercompany_connection_sides WHERE company_id = $1', c);
      await pool.query('DELETE FROM intercompany_connections WHERE company_low_id = $1 OR company_high_id = $1', c);
      await pool.query('DELETE FROM supplier_expectations WHERE company_id = $1', c);
      await pool.query('DELETE FROM expected_invoice_alerts WHERE company_id = $1', c);
      await pool.query('DELETE FROM credit_notes WHERE company_id = $1', c);
      await pool.query('DELETE FROM purchase_orders WHERE company_id = $1', c);
      await pool.query('UPDATE supplier_invoices SET gl_journal_entry_id = NULL WHERE company_id = $1', c);
      await pool.query('DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id = $1)', c);
      await pool.query('DELETE FROM supplier_invoices WHERE company_id = $1', c);
      await pool.query('DELETE FROM gl_journal_lines WHERE company_id = $1', c);
      await pool.query('DELETE FROM gl_journal_entries WHERE company_id = $1', c);
      await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = $1)', c);
      await pool.query('DELETE FROM gl_accounts WHERE company_id = $1', c);
      await pool.query('DELETE FROM fiscal_periods WHERE company_id = $1', c);
      await pool.query('DELETE FROM suppliers WHERE company_id = $1', c);
      await pool.query('DELETE FROM company_users WHERE company_id = $1', c);
      await pool.query('DELETE FROM audit_log WHERE company_id = $1', c);
      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
      await pool.query('DELETE FROM companies WHERE id = $1', c);
    } finally { await pool.end(); }
  }

  return { pool, companyId, userId, tag, applicationName, inRequestTx, syncSuppliers, byRef, liveNamed, insPlain, bill, billSupplier, seed, drop };
}
