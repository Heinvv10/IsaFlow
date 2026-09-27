/**
 * R-035 PR2: the database backstop on supplier_invoices (design test 8, the
 * raw-SQL and import bullets).
 *
 * With enforcement on and a rule matching, a bill may not ENTER the AP
 * population — INSERTed as, or moved from draft to, any population status —
 * without an approved request for its CURRENT content decided since
 * enforcement was switched on. Every writer is held to it, app_user and the
 * owner role alike (scripts), except the three importers of bills approved in
 * their source system, which declare `isaflow.approval_gate_exempt` = 'import'
 * (decision Q1).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '../../src/lib/als';
import { commitAPInvoice } from '../../src/modules/admin/services/sageMigrationCommitService';
import { importSupplierInvoices } from '../../src/modules/accounting/services/core/sageSupplierInvoiceImportService';
import { importAPInvoices } from '../../src/modules/accounting/services/ap/migrationApService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, plantBill, plantRule, type Bill } from './r035-approval.helpers';
import { cleanupPr2, enforce, postableCompany } from './r035-pr2.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let owner = '';
let other = '';

beforeAll(async () => {
  owner = await createUser(pool, tokens);
  other = await createUser(pool, tokens);
});
afterAll(async () => {
  await pool.query('DELETE FROM sage_supplier_invoices WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM gl_migration_runs WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM migration_sessions WHERE company_id = ANY($1)', [companies]);
  await cleanupPr2(pool, companies, [owner, other]);
});

async function gated(opts: { enforced?: boolean } = {}): Promise<{ c: string; bill: Bill }> {
  const c = await postableCompany(pool, [[owner, 'owner'], [other, 'owner']], companies);
  await plantRule(pool, c, 'owner');
  if (opts.enforced !== false) await enforce(pool, c, owner);
  return { c, bill: await plantBill(pool, c, owner) };
}

/** One transaction as app_user in `companyId`, the role every request runs as. */
async function asAppUser<T>(companyId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: owner, role: 'authenticated' })]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [companyId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** A service call as `owner`, in its own committed transaction. */
async function asService<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await als.run({ client, userId: owner, companyId, claims: {} } as never, fn);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const approveRaw = (client: PoolClient | Pool, id: string) =>
  client.query("UPDATE supplier_invoices SET status = 'approved' WHERE id = $1", [id]);
const statusOf = async (id: string) =>
  (await pool.query('SELECT status FROM supplier_invoices WHERE id = $1', [id])).rows[0]?.status as string;

async function approvedRequest(c: string, billId: string, digest: 'current' | 'other' = 'current'): Promise<void> {
  await pool.query(
    `INSERT INTO approval_requests(company_id, document_type, document_id, status, requested_by, required_role,
       decided_by, decided_at, document_digest)
     VALUES($1,'supplier_invoice',$2,'approved',$3,'owner',$4, now(),
            CASE $5 WHEN 'current' THEN approval_document_digest($1,'supplier_invoice',$2) ELSE md5('x') END)`,
    [c, billId, other, owner, digest]);
}

describe('raw writes are refused', () => {
  it("UPDATE status = 'approved' as app_user raises, and the bill stays a draft", async () => {
    const { c, bill } = await gated();
    await expect(asAppUser(c, (client) => approveRaw(client, bill.id))).rejects.toThrow(/R035_APPROVAL_REQUIRED/);
    expect(await statusOf(bill.id)).toBe('draft');
  });

  it("INSERT with status 'approved' as app_user raises", async () => {
    const { c, bill } = await gated();
    await expect(asAppUser(c, (client) => client.query(
      `INSERT INTO supplier_invoices(company_id,invoice_number,supplier_id,invoice_date,subtotal,tax_amount,total_amount,status,created_by)
       VALUES($1,'R035-RAW-INS',$2,DATE '2026-09-01',100,15,115,'approved',$3)`, [c, bill.supplierId, owner])))
      .rejects.toThrow(/R035_APPROVAL_REQUIRED/);
  });

  it('the owner role (an offline script) is held to it too', async () => {
    const { bill } = await gated();
    await expect(approveRaw(pool, bill.id)).rejects.toThrow(/R035_APPROVAL_REQUIRED/);
    await expect(pool.query("UPDATE supplier_invoices SET status = 'paid' WHERE id = $1", [bill.id]))
      .rejects.toThrow(/R035_APPROVAL_REQUIRED/);
  });

  it('an approval for different content does not clear it', async () => {
    const { c, bill } = await gated();
    await approvedRequest(c, bill.id, 'other');
    await expect(approveRaw(pool, bill.id)).rejects.toThrow(/R035_APPROVAL_REQUIRED/);
  });

  it('changing the content in the same UPDATE as the status is judged on the NEW content', async () => {
    const { c, bill } = await gated();
    await approvedRequest(c, bill.id);
    await expect(pool.query(
      "UPDATE supplier_invoices SET status = 'approved', invoice_date = DATE '2026-09-05' WHERE id = $1", [bill.id]))
      .rejects.toThrow(/R035_APPROVAL_REQUIRED/);
  });
});

describe('what the backstop lets through', () => {
  it('a cleared approval', async () => {
    const { c, bill } = await gated();
    await approvedRequest(c, bill.id);
    await approveRaw(pool, bill.id);
    expect(await statusOf(bill.id)).toBe('approved');
  });

  it('enforcement off', async () => {
    const { bill } = await gated({ enforced: false });
    await approveRaw(pool, bill.id);
    expect(await statusOf(bill.id)).toBe('approved');
  });

  it('the declared import exemption, for the transaction that sets it', async () => {
    const { c, bill } = await gated();
    await asAppUser(c, async (client) => {
      await client.query("SELECT set_config('isaflow.approval_gate_exempt', 'import', true)");
      await approveRaw(client, bill.id);
    });
    expect(await statusOf(bill.id)).toBe('approved');
  });
});

describe('the importers are exempt (Q1)', () => {
  it('Sage migration commit (commitAPInvoice) books an approved bill', async () => {
    const { c } = await gated();
    const supplier = (await pool.query("SELECT name FROM suppliers WHERE company_id = $1 LIMIT 1", [c])).rows[0].name as string;
    const outcome = await asService(c, () => commitAPInvoice(c, owner, {
      invoiceNumber: 'R035-SAGE-COMMIT', supplierName: supplier, invoiceDate: '2026-09-01',
      subtotal: 100, taxAmount: 15, totalAmount: 115,
    }));
    expect(await statusOf(outcome.invoiceId)).toBe('approved');
  });

  it('Sage staging import (importSupplierInvoices) books an approved bill', async () => {
    const { c } = await gated();
    const supplier = (await pool.query("SELECT name FROM suppliers WHERE company_id = $1 LIMIT 1", [c])).rows[0].name as string;
    await pool.query(
      `INSERT INTO sage_supplier_invoices(company_id, sage_id, invoice_number, supplier_name, invoice_date, total_amount)
       VALUES($1, 'R035-S1', 'R035-SAGE-STAGE', $2, DATE '2026-09-01', 230)`, [c, supplier]);
    await asService(c, () => importSupplierInvoices(c, owner));
    const { rows } = await pool.query(
      "SELECT status FROM supplier_invoices WHERE company_id = $1 AND invoice_number = 'R035-SAGE-STAGE'", [c]);
    expect(rows.map((x) => x.status)).toEqual(['approved']);
  });

  it('AP take-on (importAPInvoices) books an approved bill', async () => {
    const { c } = await gated();
    await pool.query(
      `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,is_system_account,account_subtype)
       VALUES ($1,'OBE${c.slice(0, 5)}','R035 OBE','equity','credit',true,true,'opening_balance_equity')`, [c]);
    const supplier = (await pool.query("SELECT name FROM suppliers WHERE company_id = $1 LIMIT 1", [c])).rows[0].name as string;
    const { rows: [session] } = await pool.query(
      `INSERT INTO migration_sessions(company_id, source_system, started_by) VALUES($1,'sage',$2) RETURNING id`, [c, owner]);
    const result = await asService(c, () => importAPInvoices(c, session.id, [{
      invoiceNumber: 'R035-TAKEON', supplierName: supplier, invoiceDate: '2026-09-01',
      subtotal: 100, taxAmount: 15, totalAmount: 115,
    }], owner));
    expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
    const { rows } = await pool.query(
      "SELECT status FROM supplier_invoices WHERE company_id = $1 AND invoice_number = 'R035-TAKEON'", [c]);
    expect(rows.map((x) => x.status)).toEqual(['approved']);
  });
});
