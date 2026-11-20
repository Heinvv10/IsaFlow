/**
 * #1655 review M1: a supplier merged away (A into B) must not come back on a Sage
 * re-sync. Before migration 1020 nothing recorded the survivor, and the Sage match
 * (live rows only) re-created A as a new live supplier, so A's new Sage bills
 * landed there and AP split from B. Now mergeSuppliers sets merged_into_id and
 * sagePartyMatch follows a deleted, merged supplier to its live survivor (a bounded,
 * cycle-safe chain). Through the real merge, commit and AP import on a throwaway
 * cluster, each in a committed request transaction.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { als } from '@/lib/als';
import { commitAPInvoice } from '@/modules/admin/services/sageMigrationCommitService';
import { commitSageMigration } from '@/modules/admin/services/sageMigrationOrchestrator';
import { mergeEntities } from '@/modules/accounting/services/core/duplicateMergeService';
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

const party = (sageId: number | undefined, name: string) => ({ name, sageId, email: '', phone: '', vatNumber: '', contactPerson: '' });
const syncSuppliers = (records: ReturnType<typeof party>[]) =>
  inRequestTx(() => commitSageMigration({ companyId, userId, pulled: { suppliers: { records } } }));
const byRef = async (ref: string) => (await pool.query(
  "SELECT id, deleted_at IS NOT NULL AS deleted, merged_into_id FROM suppliers WHERE company_id = $1 AND external_system = 'sage' AND external_ref = $2",
  [companyId, ref])).rows;
const liveNamed = async (name: string) => (await pool.query(
  'SELECT id, external_ref FROM suppliers WHERE company_id = $1 AND deleted_at IS NULL AND lower(name) = lower($2) ORDER BY created_at',
  [companyId, name])).rows;

let a = '';
let b = '';

beforeAll(async () => {
  await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [companyId, `i1655 merged ${tag}`]);
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
  clearSystemAccountCache(companyId);
  // Sage holds A and B as two suppliers; IsaFlow imports both, then a user merges A into B.
  await syncSuppliers([party(801, 'Hill Hardware'), party(802, 'Hill Hardware Pty Ltd')]);
  a = String((await byRef('801'))[0].id);
  b = String((await byRef('802'))[0].id);
  await inRequestTx(() => mergeEntities(companyId, 'supplier', b, a, userId));
}, 60000);

afterAll(async () => {
  try {
    clearSystemAccountCache(companyId);
    const c = [companyId];
    await pool.query('UPDATE supplier_invoices SET gl_journal_entry_id = NULL WHERE company_id = $1', c);
    await pool.query('DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id = $1)', c);
    await pool.query('DELETE FROM supplier_invoices WHERE company_id = $1', c);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id = $1', c);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id = $1', c);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = $1)', c);
    await pool.query('DELETE FROM gl_accounts WHERE company_id = $1', c);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id = $1', c);
    await pool.query('DELETE FROM suppliers WHERE company_id = $1', c);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.query('DELETE FROM companies WHERE id = $1', c);
  } finally { await pool.end(); }
}, 60000);

describe('a merged-away supplier resolves to its survivor on a Sage re-sync (#1655 M1)', () => {
  it('the merge records its survivor', async () => {
    expect(await byRef('801')).toEqual([{ id: a, deleted: true, merged_into_id: b }]);
  });

  it('re-syncing both Sage suppliers inserts nothing: A matches B, and B keeps its own Sage id', async () => {
    expect((await syncSuppliers([party(801, 'Hill Hardware'), party(802, 'Hill Hardware Pty Ltd')])).suppliers)
      .toEqual({ created: 0, skipped: 2, failed: [] });
    expect(await liveNamed('Hill Hardware')).toEqual([]);
    expect(await liveNamed('Hill Hardware Pty Ltd')).toEqual([{ id: b, external_ref: '802' }]);
  });

  it('a pull without Sage ids still reaches the survivor by the merged-away name', async () => {
    expect((await syncSuppliers([party(undefined, 'hill hardware ')])).suppliers).toEqual({ created: 0, skipped: 1, failed: [] });
    expect(await liveNamed('Hill Hardware')).toEqual([]);
  });

  it('a survivor reached through a merge is not stamped with the merged-away Sage id', async () => {
    // B2 was keyed in by hand (no Sage id); Sage A2 was imported and then merged into it.
    const b2 = String((await pool.query("INSERT INTO suppliers (company_id, name) VALUES ($1, 'Ivy Paints Ltd') RETURNING id",
      [companyId])).rows[0].id);
    await syncSuppliers([party(811, 'Ivy Paints')]);
    const a2 = String((await byRef('811'))[0].id);
    await inRequestTx(() => mergeEntities(companyId, 'supplier', b2, a2, userId));
    // A2 first: it reaches B2 through the merge and must leave B2 unstamped, so Sage's own B2 (812) still finds it by name.
    expect((await syncSuppliers([party(811, 'Ivy Paints'), party(812, 'Ivy Paints Ltd')])).suppliers)
      .toEqual({ created: 0, skipped: 2, failed: [] });
    expect(await liveNamed('Ivy Paints Ltd')).toEqual([{ id: b2, external_ref: '812' }]);
  });

  it("a new Sage bill for A lands on B", async () => {
    const number = `AP-M1-${tag}`;
    const out = await inRequestTx(() => commitAPInvoice(companyId, userId, {
      invoiceNumber: number, supplierName: 'Hill Hardware', supplierSageId: 801, invoiceDate: '2026-04-02',
      subtotal: 100, taxAmount: 15, totalAmount: 115, amountPaid: 115,
    }));
    expect(out.created).toBe(true);
    const { rows } = await pool.query('SELECT supplier_id FROM supplier_invoices WHERE company_id = $1 AND invoice_number = $2',
      [companyId, number]);
    expect(rows.map((r) => String(r.supplier_id))).toEqual([b]);
  });

  it('a chain (C into D, D into E) resolves to the end; a cycle of deleted rows ends, and the party is created live', async () => {
    const ins = async (name: string, ref: string) => String((await pool.query(
      "INSERT INTO suppliers (company_id, name, external_system, external_ref) VALUES ($1, $2, 'sage', $3) RETURNING id",
      [companyId, name, ref])).rows[0].id);
    const [cId, dId, eId] = [await ins('Chain C', '901'), await ins('Chain D', '902'), await ins('Chain E', '903')];
    await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [cId, dId]);
    await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [dId, eId]);
    expect((await syncSuppliers([party(901, 'Chain C')])).suppliers).toEqual({ created: 0, skipped: 1, failed: [] });
    expect((await liveNamed('Chain C'))).toEqual([]);

    const [xId, yId] = [await ins('Loop X', '911'), await ins('Loop Y', '912')];
    await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [xId, yId]);
    await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [yId, xId]);
    expect((await syncSuppliers([party(911, 'Loop X')])).suppliers).toEqual({ created: 1, skipped: 0, failed: [] });
    expect((await liveNamed('Loop X')).map((r) => r.external_ref)).toEqual(['911']);
  });
});
