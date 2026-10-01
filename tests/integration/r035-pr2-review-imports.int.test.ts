/**
 * R-035 PR2 review HIGH-2 (Hein: "exempt only for high enough rank").
 *
 * The importers of bills approved in their source system bypass the approval
 * backstop. With enforcement ON for supplier invoices, that exemption is
 * honoured for an OPEN bill (one entering the AP population owing money) only
 * when the importing user's company role ranks at least as high as the
 * strictest active supplier-invoice rule — otherwise the import is refused
 * before anything is written. A fully-paid historic bill imports for anyone,
 * and with enforcement off nothing changes. Enforced in the services, so the
 * exemption cannot be reached around a route.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { als } from '../../src/lib/als';
import apInvoicesRoute from '../../pages/api/accounting/migration/ap-invoices';
import sageMigrationAction from '../../pages/api/accounting/sage-migration-action';
import { commitAPInvoice } from '../../src/modules/admin/services/sageMigrationCommitService';
import { withApprovalGateExempt } from '../../src/modules/accounting/services/gl/approvalGateExempt';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule, reasonOf } from './r035-approval.helpers';
import { cleanupPr2, enforce, postableCompany } from './r035-pr2.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { owner: '', admin: '', manager: '' };

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(async () => {
  await pool.query('DELETE FROM sage_supplier_invoices WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM gl_migration_runs WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM migration_sessions WHERE company_id = ANY($1)', [companies]);
  await cleanupPr2(pool, companies, Object.values(u));
});

async function fixture(opts: { enforced?: boolean } = {}) {
  const c = await postableCompany(pool, [[u.owner, 'owner'], [u.admin, 'admin'], [u.manager, 'manager']], companies);
  await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,is_system_account,account_subtype)
     VALUES ($1,'OBE${c.slice(0, 5)}','R035 OBE','equity','credit',true,true,'opening_balance_equity')`, [c]);
  const supplier = `R035 Import ${c.slice(0, 6)}`;
  await pool.query('INSERT INTO suppliers(company_id,name,is_active) VALUES($1,$2,true)', [c, supplier]);
  await plantRule(pool, c, 'owner');
  if (opts.enforced !== false) await enforce(pool, c, u.owner);
  return { c, supplier };
}

const bills = async (c: string) => (await pool.query(
  'SELECT invoice_number, status FROM supplier_invoices WHERE company_id = $1 ORDER BY invoice_number', [c])).rows;

async function takeOn(user: string, c: string, supplier: string, amountPaid: number) {
  const { rows: [session] } = await pool.query(
    "INSERT INTO migration_sessions(company_id, source_system, started_by) VALUES($1,'sage',$2) RETURNING id", [c, user]);
  return callRoute(apInvoicesRoute, tokens[user]!, c, 'POST', {
    sessionId: session.id,
    invoices: [{ invoiceNumber: 'R035-TO-1', supplierName: supplier, invoiceDate: '2026-09-01', dueDate: '2026-10-01',
      subtotal: 100, taxAmount: 15, totalAmount: 115, amountPaid }],
  }, '/api/accounting/migration/ap-invoices');
}

describe('AP take-on', () => {
  it('refuses a manager an OPEN bill under an owner rule — 403, nothing written', async () => {
    const { c, supplier } = await fixture();
    const res = await takeOn(u.manager, c, supplier, 0);
    expect(res.state.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('IMPORT_APPROVAL_AUTHORITY_REQUIRED');
    expect(await bills(c)).toEqual([]);
  });

  it("an owner's take-on of the same bill imports it approved", async () => {
    const { c, supplier } = await fixture();
    const res = await takeOn(u.owner, c, supplier, 0);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await bills(c), JSON.stringify(res.state.body)).toEqual([{ invoice_number: 'R035-TO-1', status: 'approved' }]);
  });

  it('a fully paid historic bill imports for anyone', async () => {
    const { c, supplier } = await fixture();
    const res = await takeOn(u.manager, c, supplier, 115);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await bills(c)).toEqual([{ invoice_number: 'R035-TO-1', status: 'paid' }]);
  });

  it('enforcement off: a manager imports an open bill as before', async () => {
    const { c, supplier } = await fixture({ enforced: false });
    expect((await takeOn(u.manager, c, supplier, 0)).state.statusCode).toBe(200);
    expect(await bills(c)).toEqual([{ invoice_number: 'R035-TO-1', status: 'approved' }]);
  });
});

describe('Sage staging import', () => {
  const stage = (c: string, supplier: string) => pool.query(
    `INSERT INTO sage_supplier_invoices(company_id, sage_id, invoice_number, supplier_name, invoice_date, total_amount)
     VALUES($1, 'R035-S', 'R035-SG-1', $2, DATE '2026-09-01', 230)`, [c, supplier]);
  const run = (user: string, c: string) => callRoute(sageMigrationAction, tokens[user]!, c, 'POST',
    { action: 'import_invoices' }, '/api/accounting/sage-migration-action');

  it('refuses an admin under an owner rule — 403 before the run is even recorded', async () => {
    const { c, supplier } = await fixture();
    await stage(c, supplier);
    const res = await run(u.admin, c);
    expect(res.state.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('IMPORT_APPROVAL_AUTHORITY_REQUIRED');
    expect(await bills(c)).toEqual([]);
    expect((await pool.query('SELECT count(*)::INT AS n FROM gl_migration_runs WHERE company_id = $1', [c])).rows[0].n).toBe(0);
  });

  it("imports for the owner", async () => {
    const { c, supplier } = await fixture();
    await stage(c, supplier);
    expect((await run(u.owner, c)).state.statusCode).toBe(200);
    expect(await bills(c)).toEqual([{ invoice_number: 'R035-SG-1', status: 'approved' }]);
  });
});

describe('Sage migration commit (the service the admin console drives)', () => {
  async function commit(user: string, c: string, supplier: string, amountPaid?: number) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await als.run({ client, userId: user, companyId: c, claims: {} } as never, () => commitAPInvoice(c, user, {
        invoiceNumber: 'R035-SC-1', supplierName: supplier, invoiceDate: '2026-09-01',
        subtotal: 100, taxAmount: 15, totalAmount: 115, ...(amountPaid !== undefined ? { amountPaid } : {}),
      }));
      await client.query('COMMIT');
      return out;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  it('refuses an admin an open bill under an owner rule, before creating it', async () => {
    const { c, supplier } = await fixture();
    await expect(commit(u.admin, c, supplier)).rejects.toMatchObject({ code: 'IMPORT_APPROVAL_AUTHORITY_REQUIRED' });
    expect(await bills(c)).toEqual([]);
  });

  it('books a fully paid bill for the admin, and an open one for the owner', async () => {
    const { c, supplier } = await fixture();
    await commit(u.admin, c, supplier, 115);
    expect(await bills(c)).toEqual([{ invoice_number: 'R035-SC-1', status: 'paid' }]);
    const other = await fixture();
    await commit(u.owner, other.c, other.supplier);
    expect(await bills(other.c)).toEqual([{ invoice_number: 'R035-SC-1', status: 'approved' }]);
  });
});

describe('the wrapper holds the rank check on its own (re-check L3)', () => {
  it('a lower rank asking to exempt an open bill is refused: no write, and the GUC is never set', async () => {
    const { c } = await fixture();
    const client = await pool.connect();
    const write = vi.fn(async () => 'written');
    try {
      await client.query('BEGIN');
      await als.run({ client, userId: u.manager, companyId: c, claims: {} } as never, async () => {
        await expect(withApprovalGateExempt({ companyId: c, userId: u.manager, open: true }, write))
          .rejects.toMatchObject({ code: 'IMPORT_APPROVAL_AUTHORITY_REQUIRED' });
      });
      const { rows } = await client.query("SELECT current_setting('isaflow.approval_gate_exempt', true) AS guc");
      expect(rows[0].guc ?? '').not.toBe('import');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect(write).not.toHaveBeenCalled();
  });
});
