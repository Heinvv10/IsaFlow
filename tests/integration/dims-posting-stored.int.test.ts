/**
 * What posts is what is stored — and so what the approval digest covers
 * (#663 review, MEDIUM 3). Posting used to derive CC1 at POST time from the
 * customer's CURRENT FNO and the CC2's CURRENT parent, so a customer FNO change
 * or a project re-parented after approval changed what posted while the
 * approval still cleared. Now the FNO is stored at save. APPROVING a draft
 * (or pending) document refuses a line posting would add a CC1 to ("re-save the
 * draft"), and a stored CC1 its project now contradicts. A document already
 * past draft — Post to GL, the backfill route — posts exactly what it stores,
 * adding and refusing nothing, so an approved invoice can never be left in AR
 * with no journal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '../../src/lib/als';
import { createDraftCustomerInvoice } from '../../src/modules/accounting/services/ar/customerInvoiceCreateService';
import { approveSupplierInvoice, postSupplierInvoiceToGL } from '../../src/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import customerInvoicesGl from '../../pages/api/accounting/customer-invoices-gl';
import { approveCreditNote } from '../../src/modules/accounting/services/ar/creditNoteApproveService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantBill } from './r035-approval.helpers';
import { postableCompany } from './r035-pr2.helpers';
import { noteCompany, plantNote } from './r035-pr3.helpers';
import { cleanupPr4, invoiceCompany, invoiceRoutes, plantInvoice } from './r035-pr4.helpers';
import { approvedFor, cleanupDims, plantDims, type Dims } from './dims-approval.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const routes = invoiceRoutes(tokens);
let owner = '';
let other = '';

beforeAll(async () => {
  owner = await createUser(pool, tokens);
  other = await createUser(pool, tokens);
});
afterAll(async () => {
  await cleanupDims(pool, companies);
  await pool.query('DELETE FROM credit_notes WHERE company_id = ANY($1)', [companies]);
  await cleanupPr4(pool, companies, [owner, other]);
});

async function inRequest<T>(c: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, userId: owner, companyId: c, claims: { sub: owner } } as never, fn);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** A CC2 with no FNO above it yet. */
const orphanProject = async (c: string) => (await pool.query(
  "INSERT INTO cost_centres(company_id, code, name, cc_type) VALUES($1,$2,$2,'cc2') RETURNING id",
  [c, `PX-${crypto.randomUUID().slice(0, 8)}`])).rows[0].id as string;
const reparent = (project: string, fno: string) => pool.query('UPDATE cost_centres SET parent_id = $2 WHERE id = $1', [project, fno]);
const revenueCc1 = async (invoiceId: string) => (await pool.query(
  `SELECT jl.cc1_id FROM customer_invoices ci JOIN gl_journal_lines jl ON jl.journal_entry_id = ci.gl_journal_entry_id
   JOIN gl_accounts a ON a.id = jl.gl_account_id AND a.account_subtype = 'default_revenue' WHERE ci.id = $1`, [invoiceId]))
  .rows.map((r) => r.cc1_id as string | null);
const statusOf = async (table: string, id: string) =>
  (await pool.query(`SELECT status, gl_journal_entry_id FROM ${table} WHERE id = $1`, [id])).rows[0];

async function invoiceFixture(): Promise<{ c: string; d: Dims }> {
  const c = await invoiceCompany(pool, [[owner, 'owner'], [other, 'owner']], companies);
  return { c, d: await plantDims(pool, c) };
}

describe('a customer invoice', () => {
  it('posts the FNO stored at save, not the customer\'s FNO after it changes, and the approval covers it', async () => {
    const { c, d } = await invoiceFixture();
    const customer = crypto.randomUUID();
    await pool.query("INSERT INTO customers(id,company_id,name,default_cc1_id) VALUES($1,$2,'F1 client',$3)", [customer, c, d.fno1]);
    const { id } = await createDraftCustomerInvoice(c, owner, {
      clientId: customer, invoiceDate: '2026-09-01', items: [{ description: 'Work', unitPrice: 1000 }] });
    await approvedFor(pool, c, 'customer_invoice', id, other, owner);
    await pool.query('UPDATE customers SET default_cc1_id = $2 WHERE id = $1', [customer, d.fno2]);
    const res = await routes.approve(owner, c, id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await revenueCc1(id)).toEqual([d.fno1]);
  });

  it('saved without the FNO its customer now has: refused at posting, nothing posted', async () => {
    const { c, d } = await invoiceFixture();
    const inv = await plantInvoice(pool, c, owner, { functionalTotal: 1150 });
    await pool.query('UPDATE customers SET default_cc1_id = $2 WHERE id = $1', [inv.customerId, d.fno1]);
    const res = await routes.approve(owner, c, inv.id);
    expect(res.state.statusCode).toBe(400);
    expect(JSON.stringify(res.state.body)).toMatch(/customer's FNO.*Re-save the draft/);
    expect(await statusOf('customer_invoices', inv.id)).toMatchObject({ status: 'draft', gl_journal_entry_id: null });
  });

  it('a project re-parented under an FNO after approval: refused, not posted with an FNO nobody approved', async () => {
    const { c, d } = await invoiceFixture();
    const inv = await plantInvoice(pool, c, owner, { functionalTotal: 1150 });
    const project = await orphanProject(c);
    await pool.query('UPDATE customer_invoice_items SET cc2_id = $2 WHERE invoice_id = $1', [inv.id, project]);
    await approvedFor(pool, c, 'customer_invoice', inv.id, other, owner);
    await reparent(project, d.fno1);
    const res = await routes.approve(owner, c, inv.id);
    expect(res.state.statusCode).toBe(400);
    expect(JSON.stringify(res.state.body)).toMatch(/project's FNO.*Re-save the draft/);
    expect(await statusOf('customer_invoices', inv.id)).toMatchObject({ status: 'draft', gl_journal_entry_id: null });
  });

  it('a stored FNO its project no longer rolls up to is refused too', async () => {
    const { c, d } = await invoiceFixture();
    const inv = await plantInvoice(pool, c, owner, { functionalTotal: 1150 });
    await pool.query('UPDATE customer_invoice_items SET cc1_id = $2, cc2_id = $3 WHERE invoice_id = $1', [inv.id, d.fno1, d.proj1]);
    await reparent(d.proj1, d.fno2);
    expect((await routes.approve(owner, c, inv.id)).state.statusCode).toBe(400);
    expect(await statusOf('customer_invoices', inv.id)).toMatchObject({ status: 'draft', gl_journal_entry_id: null });
  });

  it('approving refuses a stored dimension that is no longer an active master; already approved, it posts as stored', async () => {
    const { c, d } = await invoiceFixture();
    const draft = await plantInvoice(pool, c, owner, { functionalTotal: 1150 });
    const approved = await plantInvoice(pool, c, owner, { functionalTotal: 1150, status: 'approved' });
    for (const id of [draft.id, approved.id]) {
      await pool.query('UPDATE customer_invoice_items SET cc1_id = $2, cc2_id = $3 WHERE invoice_id = $1', [id, d.fno1, d.proj1]);
    }
    await pool.query('UPDATE cost_centres SET is_active = false WHERE id = $1', [d.proj1]);
    const res = await routes.approve(owner, c, draft.id);
    expect(res.state.statusCode).toBe(400);
    expect(JSON.stringify(res.state.body)).toMatch(/CC2 must name an active CC2 cost centre/);
    const posted = await callRoute(customerInvoicesGl as never, tokens[owner]!, c, 'POST', { invoiceId: approved.id },
      '/api/accounting/customer-invoices-gl');
    expect(posted.state.statusCode, JSON.stringify(posted.state.body)).toBe(200);
    expect(await revenueCc1(approved.id)).toEqual([d.fno1]);
  });
});

describe('a bill and a credit note', () => {
  it('a bill whose project gained an FNO after it was saved is refused, not posted with it', async () => {
    const c = await postableCompany(pool, [[owner, 'owner']], companies);
    const d = await plantDims(pool, c);
    const bill = await plantBill(pool, c, owner);
    const project = await orphanProject(c);
    await pool.query('UPDATE supplier_invoice_items SET cc2_id = $2 WHERE supplier_invoice_id = $1', [bill.id, project]);
    await reparent(project, d.fno1);
    await expect(inRequest(c, () => approveSupplierInvoice(c, bill.id, owner))).rejects.toThrow(/project's FNO.*Re-save the draft/);
    expect(await statusOf('supplier_invoices', bill.id)).toMatchObject({ status: 'draft', gl_journal_entry_id: null });
  });

  it.each(['customer', 'supplier'] as const)('a %s credit note whose project gained an FNO is refused', async (type) => {
    const c = await noteCompany(pool, [[owner, 'owner']], companies);
    const d = await plantDims(pool, c);
    const note = await plantNote(pool, c, owner, type);
    const project = await orphanProject(c);
    await pool.query('UPDATE credit_notes SET cc2_id = $2 WHERE id = $1', [note.id, project]);
    await reparent(project, d.fno1);
    await expect(inRequest(c, () => approveCreditNote(c, note.id, owner))).rejects.toThrow(/project's FNO.*Re-save the draft/);
    expect((await statusOf('credit_notes', note.id)).status).toBe('draft');
  });
});

describe('a document already past draft posts exactly what it stores', () => {
  const postGl = (c: string, invoiceId: string) => callRoute(customerInvoicesGl as never, tokens[owner]!, c, 'POST',
    { invoiceId }, '/api/accounting/customer-invoices-gl');
  const revenueDims = async (invoiceId: string) => (await pool.query(
    `SELECT jl.cc1_id, jl.cc2_id FROM customer_invoices ci JOIN gl_journal_lines jl ON jl.journal_entry_id = ci.gl_journal_entry_id
     JOIN gl_accounts a ON a.id = jl.gl_account_id AND a.account_subtype = 'default_revenue' WHERE ci.id = $1`, [invoiceId])).rows;

  it('an approved, never-posted invoice whose customer has since gained an FNO posts, without it', async () => {
    const { c, d } = await invoiceFixture();
    const inv = await plantInvoice(pool, c, owner, { functionalTotal: 1150, status: 'approved' });
    await pool.query('UPDATE customers SET default_cc1_id = $2 WHERE id = $1', [inv.customerId, d.fno1]);
    const res = await postGl(c, inv.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await revenueDims(inv.id)).toEqual([{ cc1_id: null, cc2_id: null }]);
  });

  it('an approved invoice whose project was re-parented posts the stored CC2 and no derived CC1', async () => {
    const { c, d } = await invoiceFixture();
    const inv = await plantInvoice(pool, c, owner, { functionalTotal: 1150, status: 'approved' });
    const project = await orphanProject(c);
    await pool.query('UPDATE customer_invoice_items SET cc2_id = $2 WHERE invoice_id = $1', [inv.id, project]);
    await reparent(project, d.fno1);
    const res = await postGl(c, inv.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await revenueDims(inv.id)).toEqual([{ cc1_id: null, cc2_id: project }]);
  });

  it('an approved bill whose project was re-parented posts (Post to GL) the stored CC2 and no derived CC1', async () => {
    const c = await postableCompany(pool, [[owner, 'owner']], companies);
    const d = await plantDims(pool, c);
    const bill = await plantBill(pool, c, owner);
    const project = await orphanProject(c);
    await pool.query("UPDATE supplier_invoice_items SET cc2_id = $2 WHERE supplier_invoice_id = $1 AND description = 'Line A'", [bill.id, project]);
    await pool.query("UPDATE supplier_invoices SET status = 'approved' WHERE id = $1", [bill.id]);
    await reparent(project, d.fno1);
    await inRequest(c, () => postSupplierInvoiceToGL(c, bill.id, owner));
    const lines = (await pool.query(
      `SELECT jl.cc1_id, jl.cc2_id FROM supplier_invoices si JOIN gl_journal_lines jl ON jl.journal_entry_id = si.gl_journal_entry_id
       WHERE si.id = $1 AND jl.gl_account_id = $2`, [bill.id, bill.accountA])).rows;
    expect(lines).toEqual([{ cc1_id: null, cc2_id: project }]);
  });
});

