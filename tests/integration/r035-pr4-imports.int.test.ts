/**
 * R-035 PR4, decision Q1: the importers of customer invoices issued in their
 * source system — the AR take-on, the Sage staging import and the Sage
 * migration commit — write straight into the AR population, and are exempt
 * from the customer-invoice backstop through the declared import GUC. As for
 * bills (PR2 review HIGH-2), the exemption is honoured for an OPEN invoice
 * (still owing money) only when the importing user's role ranks at least as
 * high as the strictest active customer-invoice rule: otherwise the import is
 * refused (403 on the routes) before anything is written. A fully paid
 * historic invoice imports for anyone, and with enforcement off nothing
 * changes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '../../src/lib/als';
import arInvoicesRoute from '../../pages/api/accounting/migration/ar-invoices';
import sageMigrationAction from '../../pages/api/accounting/sage-migration-action';
import { commitARInvoice } from '../../src/modules/admin/services/sageMigrationCommitService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule, reasonOf } from './r035-approval.helpers';
import { cleanupPr4, enforceInvoices, invoiceCompany } from './r035-pr4.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { owner: '', admin: '', manager: '' };

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr4(pool, companies, Object.values(u)));

async function fixture(opts: { enforced?: boolean } = {}) {
  const c = await invoiceCompany(pool, [[u.owner, 'owner'], [u.admin, 'admin'], [u.manager, 'manager']], companies);
  await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,is_system_account,account_subtype)
     VALUES ($1,$2,'R035 OBE','equity','credit',true,true,'opening_balance_equity')`, [c, `OBE${c.slice(0, 5)}`]);
  const customer = `R035 Import ${c.slice(0, 6)}`;
  await pool.query('INSERT INTO customers(company_id,name,is_active) VALUES($1,$2,true)', [c, customer]);
  await plantRule(pool, c, 'owner', { documentType: 'customer_invoice' });
  if (opts.enforced !== false) await enforceInvoices(pool, c, u.owner);
  return { c, customer };
}

const invoices = async (c: string) => (await pool.query(
  'SELECT invoice_number, status FROM customer_invoices WHERE company_id = $1 ORDER BY invoice_number', [c])).rows;

describe('AR take-on', () => {
  async function takeOn(user: string, c: string, customer: string, amountPaid: number) {
    const { rows: [session] } = await pool.query(
      "INSERT INTO migration_sessions(company_id, source_system, started_by) VALUES($1,'sage',$2) RETURNING id", [c, user]);
    return callRoute(arInvoicesRoute, tokens[user]!, c, 'POST', {
      sessionId: session.id,
      invoices: [{ invoiceNumber: 'R035-AR-1', customerName: customer, invoiceDate: '2026-09-01', dueDate: '2026-10-01',
        subtotal: 100, taxAmount: 15, totalAmount: 115, amountPaid }],
    }, '/api/accounting/migration/ar-invoices');
  }

  it('refuses a manager an OPEN invoice under an owner rule — 403, nothing written', async () => {
    const { c, customer } = await fixture();
    const res = await takeOn(u.manager, c, customer, 0);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(403);
    expect(reasonOf(res)).toBe('IMPORT_APPROVAL_AUTHORITY_REQUIRED');
    expect(await invoices(c)).toEqual([]);
  });

  it("an owner's take-on of the same invoice imports it approved, past the backstop", async () => {
    const { c, customer } = await fixture();
    const res = await takeOn(u.owner, c, customer, 0);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await invoices(c), JSON.stringify(res.state.body)).toEqual([{ invoice_number: 'R035-AR-1', status: 'approved' }]);
  });

  it('a fully paid historic invoice imports for anyone', async () => {
    const { c, customer } = await fixture();
    const res = await takeOn(u.manager, c, customer, 115);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await invoices(c)).toEqual([{ invoice_number: 'R035-AR-1', status: 'paid' }]);
  });

  it('enforcement off: a manager imports an open invoice as before', async () => {
    const { c, customer } = await fixture({ enforced: false });
    expect((await takeOn(u.manager, c, customer, 0)).state.statusCode).toBe(200);
    expect(await invoices(c)).toEqual([{ invoice_number: 'R035-AR-1', status: 'approved' }]);
  });
});

describe('Sage staging import', () => {
  const stage = (c: string, customer: string) => pool.query(
    `INSERT INTO sage_customer_invoices(company_id, sage_id, invoice_number, customer_name, invoice_date, total_amount)
     VALUES($1, 'R035-S', 'R035-SG-1', $2, DATE '2026-09-01', 230)`, [c, customer]);
  const run = (user: string, c: string) => callRoute(sageMigrationAction, tokens[user]!, c, 'POST',
    { action: 'import_customer_invoices' }, '/api/accounting/sage-migration-action');

  it('refuses an admin under an owner rule — 403 before the run is even recorded', async () => {
    const { c, customer } = await fixture();
    await stage(c, customer);
    const res = await run(u.admin, c);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(403);
    expect(reasonOf(res)).toBe('IMPORT_APPROVAL_AUTHORITY_REQUIRED');
    expect(await invoices(c)).toEqual([]);
    expect((await pool.query('SELECT count(*)::INT AS n FROM gl_migration_runs WHERE company_id = $1', [c])).rows[0].n).toBe(0);
  });

  it('imports for the owner, past the backstop', async () => {
    const { c, customer } = await fixture();
    await stage(c, customer);
    const res = await run(u.owner, c);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await invoices(c)).toEqual([{ invoice_number: 'R035-SG-1', status: 'approved' }]);
  });
});

describe('Sage migration commit (the service the admin console drives)', () => {
  async function commit(user: string, c: string, customer: string, amountPaid?: number) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await als.run({ client, userId: user, companyId: c, claims: {} } as never, () => commitARInvoice(c, user, {
        invoiceNumber: 'R035-SC-1', customerName: customer, invoiceDate: '2026-09-01',
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

  it('refuses an admin an open invoice under an owner rule, before creating it', async () => {
    const { c, customer } = await fixture();
    await expect(commit(u.admin, c, customer)).rejects.toMatchObject({ code: 'IMPORT_APPROVAL_AUTHORITY_REQUIRED' });
    expect(await invoices(c)).toEqual([]);
  });

  it('books a fully paid invoice for the admin, and an open one for the owner', async () => {
    const { c, customer } = await fixture();
    await commit(u.admin, c, customer, 115);
    expect(await invoices(c)).toEqual([{ invoice_number: 'R035-SC-1', status: 'paid' }]);
    const other = await fixture();
    await commit(u.owner, other.c, other.customer);
    expect(await invoices(other.c)).toEqual([{ invoice_number: 'R035-SC-1', status: 'approved' }]);
  });
});
