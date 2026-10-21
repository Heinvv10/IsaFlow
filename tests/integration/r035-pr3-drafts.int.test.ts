/**
 * R-035 PR3, "pin, don't gate": the paths that CREATE a credit note write a
 * draft and post nothing, so approval enforcement has nothing to refuse them
 * for. With enforcement on for both types and an `any` rule on each, every
 * one still answers success, leaves its note a draft, and writes no journal:
 *
 *  - dispute resolution with credit (ar/disputes/[id]/resolve)
 *  - a supplier return (supplier-returns POST)
 *  - credit-notes POST, supplier-credit-notes POST submitAction 'draft'
 *  - MCP create_credit_note
 *
 * The census (creditNoteApprovalCensus.test.ts) pins that these are the only
 * creators; this proves what they write.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '../../src/lib/als';
import { McpRegistry } from '../../src/lib/mcp/registry';
import { createCreditNoteTool } from '../../src/lib/mcp/tools/writeCreditNotes';
import disputeResolve from '../../pages/api/accounting/ar/disputes/[id]/resolve';
import supplierReturns from '../../pages/api/accounting/supplier-returns';
import creditNotes from '../../pages/api/accounting/credit-notes';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import { cleanupPr3, enforceType, noteCompany, noteRoutes, noteState } from './r035-pr3.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '' };
const r = noteRoutes(tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(async () => {
  await pool.query('DELETE FROM customer_invoice_disputes WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM company_document_numbers WHERE company_id = ANY($1)', [companies]);
  await cleanupPr3(pool, companies, Object.values(u));
});

/** Both types enforced, an `any` rule on each: every note a rule could see is held. */
async function enforcedCompany(): Promise<{ c: string; customer: string; supplier: string }> {
  const c = await noteCompany(pool, [[u.a, 'admin'], [u.b, 'owner']], companies);
  for (const type of ['customer', 'supplier'] as const) {
    await plantRule(pool, c, 'owner', { documentType: `${type}_credit_note` });
    await enforceType(pool, c, type, u.b);
  }
  const customer = crypto.randomUUID();
  const supplier = crypto.randomUUID();
  await pool.query("INSERT INTO customers(id,company_id,name) VALUES($1,$2,'R035 drafts customer')", [customer, c]);
  await pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'R035 drafts supplier')", [supplier, c]);
  return { c, customer, supplier };
}

const expectDraft = async (id: string) =>
  expect(await noteState(pool, id)).toMatchObject({ status: 'draft', gl_journal_entry_id: null, journals: 0 });

describe('drafts-only creators are not gated, and post nothing', () => {
  it('dispute resolution with credit creates a draft customer note', async () => {
    const { c, customer } = await enforcedCompany();
    const invoice = crypto.randomUUID();
    const dispute = crypto.randomUUID();
    await pool.query(
      `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,client_id,invoice_date,due_date,subtotal,tax_amount,total_amount,status,created_by)
       VALUES($1,$2,$3,$4,$4,'2026-09-01','2026-09-30',1000,150,1150,'approved',$5)`, [invoice, c, `R035-D-${invoice.slice(0, 6)}`, customer, u.a]);
    await pool.query(
      `INSERT INTO customer_invoice_disputes(id,company_id,customer_invoice_id,reason,raised_by,disputed_amount,status)
       VALUES($1,$2,$3,'R035 pricing',$4,115,'open')`, [dispute, c, invoice, u.a]);
    const res = await callRoute(disputeResolve, tokens[u.a]!, c, 'POST',
      { mode: 'resolve_with_credit', creditDate: '2026-09-02' }, `/api/accounting/ar/disputes/${dispute}/resolve`, { id: dispute });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    await expectDraft(dataOf<{ creditNoteId: string }>(res).creditNoteId);
  });

  it('a supplier return creates a draft supplier note', async () => {
    const { c, supplier } = await enforcedCompany();
    const res = await callRoute(supplierReturns, tokens[u.a]!, c, 'POST',
      { supplierId: supplier, amount: 500, reason: 'R035 return' }, '/api/accounting/supplier-returns');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    await expectDraft(dataOf<{ return: { id: string } }>(res).return.id);
  });

  it('credit-notes POST and supplier-credit-notes POST (draft) create drafts', async () => {
    const { c, customer, supplier } = await enforcedCompany();
    const created = await callRoute(creditNotes, tokens[u.a]!, c, 'POST',
      { type: 'customer', clientId: customer, creditDate: '2026-09-02', subtotal: 1000 }, '/api/accounting/credit-notes');
    expect(created.state.statusCode, JSON.stringify(created.state.body)).toBe(201);
    await expectDraft(dataOf<{ id: string }>(created).id);
    const draft = await r.createSupplier(u.a, c, supplier, 'draft');
    expect(draft.state.statusCode, JSON.stringify(draft.state.body)).toBe(201);
    await expectDraft(dataOf<{ id: string }>(draft).id);
  });

  it('MCP create_credit_note creates a draft', async () => {
    const { c, supplier } = await enforcedCompany();
    const registry = new McpRegistry();
    registry.register(createCreditNoteTool);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const res = await als.run({ client, userId: u.a, companyId: c, claims: { sub: u.a } } as never, () => registry.call(
        'create_credit_note',
        { type: 'supplier', supplier_id: supplier, credit_date: '2026-09-02', subtotal: 200, idempotency_key: `r035-pr3-create-${c}` },
        { userId: u.a, companyId: c, scopes: ['write:invoices'], companyRole: 'owner', tokenJti: 'r035-pr3', oauthAppId: null }));
      await client.query('COMMIT');
      expect(res.isError, res.content[0]!.text).toBeFalsy();
      await expectDraft((JSON.parse(res.content[0]!.text) as { id: string }).id);
    } finally {
      client.release();
    }
  });
});
