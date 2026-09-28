// tests/integration/r146-documents-supplier-invoice-fence.int.test.ts
//
// R-146. The bill page's documents panel sends a `supplier_invoices.id` with
// entity_type 'supplier_invoice'. Every place that resolved that entity type
// to its tenant — verifyEntityOwnership, the procurement_documents RLS policy,
// the VLM-extraction fence and the PO/GRN auto-link — looked it up in
// `sage_supplier_invoices` (the Sage import staging table) instead, so every
// supplier invoice in every company answered 403 "Entity does not belong to
// your company".
//
// Driven through the real handler (withAuth, app_user, GUCs), because the fix
// has two halves that only meet there: the ownership fence in code and the
// RLS policy the SELECT runs under. The user is a member of BOTH companies,
// so RLS membership alone would show company B's bill documents — the
// cross-tenant refusal below can only come from the active-company fence.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import documents from '../../pages/api/accounting/documents';
import { autoLinkSupplierInvoice } from '@/modules/accounting/services/core/documentStorageService';

assertDisposable();

const A = randomUUID(), B = randomUUID(), USER = randomUUID();
const SUP_A = randomUUID(), SUP_B = randomUUID();
const SI_A = randomUUID(), SI_B = randomUUID();
const DOC_A = randomUUID(), DOC_B = randomUUID();
const PO_A = randomUUID();

describe('R-146 — documents on a supplier invoice are fenced on supplier_invoices', () => {
  let pool: Pool;
  let token = '';

  async function call(method: string, query: Record<string, string>) {
    const req = request({ 'sb-access-token': token, active_company_id: A }, method) as never as
      { query: Record<string, string>; url: string };
    req.query = query;
    req.url = '/api/accounting/documents';
    const out = response();
    await documents(req as never, out.res as never);
    return out.state as { statusCode: number; body: { data?: Array<{ id: string }> } };
  }

  const isActive = async (id: string) =>
    (await pool.query('SELECT is_active FROM procurement_documents WHERE id = $1', [id])).rows[0].is_active;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true), ($3, $4, true)',
      [A, 'R146 Co A', B, 'R146 Co B']);
    await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)",
      [USER, `r146-${USER}@isaflow.test`]);
    await pool.query(
      "INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $3, 'admin'), ($2, $3, 'admin')",
      [A, B, USER]);
    await pool.query('INSERT INTO suppliers (id, company_id, name) VALUES ($1, $2, $3), ($4, $5, $6)',
      [SUP_A, A, 'R146 Supplier A', SUP_B, B, 'R146 Supplier B']);
    for (const [id, co, sup, po] of [[SI_A, A, SUP_A, PO_A], [SI_B, B, SUP_B, null]] as const) {
      await pool.query(
        `INSERT INTO supplier_invoices (id, company_id, invoice_number, supplier_id, invoice_date,
           subtotal, total_amount, status, created_by, purchase_order_id)
         VALUES ($1, $2, $3, $4, CURRENT_DATE, 100, 115, 'draft', $5, $6)`,
        [id, co, `R146-${id.slice(0, 8)}`, sup, USER, po]);
    }
    await pool.query(
      `INSERT INTO procurement_documents (id, entity_type, entity_id, document_type, document_name,
         mime_type, file_size, is_active)
       VALUES ($1, 'supplier_invoice', $2, 'invoice', 'r146-a.pdf', 'application/pdf', 8, true),
              ($3, 'supplier_invoice', $4, 'invoice', 'r146-b.pdf', 'application/pdf', 8, true)`,
      [DOC_A, SI_A, DOC_B, SI_B]);
    token = await new SignJWT({ sub: USER, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      await pool.query('DELETE FROM document_links WHERE document_id = ANY($1::uuid[])', [[DOC_A, DOC_B]]);
      await pool.query('DELETE FROM procurement_documents WHERE id = ANY($1::uuid[])', [[DOC_A, DOC_B]]);
      for (const t of ['supplier_invoices', 'suppliers', 'company_users']) {
        await pool.query(`DELETE FROM ${t} WHERE company_id = ANY($1::uuid[])`, [[A, B]]);
      }
      await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[A, B]]);
      await pool.query('DELETE FROM users WHERE id = $1', [USER]);
    } finally {
      await pool.end();
    }
  });

  it("GET lists the active company's own supplier invoice documents (200)", async () => {
    const state = await call('GET', { entity_type: 'supplier_invoice', entity_id: SI_A });
    expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
    expect(state.body.data?.map((d) => d.id)).toEqual([DOC_A]);
  });

  it("GET refuses another company's supplier invoice (403) even for a member of both", async () => {
    const state = await call('GET', { entity_type: 'supplier_invoice', entity_id: SI_B });
    expect(state.statusCode).toBe(403);
    expect(JSON.stringify(state.body)).not.toContain(DOC_B);
  });

  it("DELETE refuses another company's supplier invoice document and leaves it active", async () => {
    const state = await call('DELETE', { id: DOC_B });
    expect(state.statusCode).toBe(403);
    expect(await isActive(DOC_B)).toBe(true);
  });

  it("DELETE soft-deletes the active company's own supplier invoice document", async () => {
    const state = await call('DELETE', { id: DOC_A });
    expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
    expect(await isActive(DOC_A)).toBe(false);
  });

  // The upload INSERT runs under the same policy's WITH CHECK: a supplier
  // invoice document can only be written against the active company's bill.
  it.each([
    ['accepts', SI_A, true],
    ['refuses', SI_B, false],
  ] as const)('RLS %s a supplier_invoice document insert as app_user in company A', async (_, si, ok) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: USER })]);
      await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [A]);
      const insert = client.query(
        `INSERT INTO procurement_documents (entity_type, entity_id, document_type, document_name)
         VALUES ('supplier_invoice', $1, 'invoice', 'r146-rls.pdf') RETURNING id`, [si]);
      if (ok) expect((await insert).rows).toHaveLength(1);
      else await expect(insert).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it("auto-link reads the bill's purchase order only for the bill's own company", async () => {
    const links = async () => (await pool.query(
      `SELECT linked_entity_id FROM document_links
       WHERE document_id = $1 AND linked_entity_type = 'purchase_order'`, [DOC_A])).rows;
    await autoLinkSupplierInvoice(DOC_A, SI_A, B);
    expect(await links()).toEqual([]);
    await autoLinkSupplierInvoice(DOC_A, SI_A, A);
    expect(await links()).toEqual([{ linked_entity_id: PO_A }]);
  });
});
