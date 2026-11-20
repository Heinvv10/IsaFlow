/**
 * #1699 review: a supplier merged away (deleted_at, merged_into_id) is no longer inactive (the supplier-merge route stopped
 * flipping is_active), so every reader that picks a supplier by is_active alone must also exclude deleted rows. Through the
 * real doc-auto-invoice and ai-invoice-pipeline routes and the provisional prediction: a vendor named like a merged-away
 * supplier matches nothing, while the same vendor named like a live supplier still matches (the harness is real).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/rateLimit', () => ({ checkAiRateLimit: async () => true }));

import docAutoInvoice from '../../pages/api/accounting/doc-auto-invoice';
import aiInvoicePipeline from '../../pages/api/accounting/ai-invoice-pipeline';
import postCapture from '../../pages/api/accounting/capture/[id]/post';
import { predictFromHistory } from '@/modules/accounting/services/capture/provisionalPrediction';
import { scanCompanyForFraud } from '@/modules/accounting/services/capture/supplierGraphService';
import { importSuppliers } from '@/modules/accounting/services/core/migrationContactService';
import { createSession } from '@/modules/accounting/services/core/migrationService';
import { importAPInvoices } from '@/modules/accounting/services/ap/migrationApService';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { sageMergedWorld } from './helpers/sageMergedSupplierWorld';

assertDisposable();
const w = sageMergedWorld('nomatch');
const { pool, companyId, userId, inRequestTx, insPlain } = w;

let live = '';
const template = crypto.randomUUID();
let mergedAway = '';
const docs: string[] = [];

beforeAll(async () => {
  await w.seed();
  live = await insPlain('Zeta Holdings');
  const survivor = await insPlain('Brightwater Foods');
  mergedAway = await insPlain('Qux Traders');
  // Merged away as both merge paths leave it: deleted, with its survivor, and still is_active.
  await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [mergedAway, survivor]);
}, 60000);
afterAll(async () => {
  await pool.query('DELETE FROM capture_events WHERE company_id = $1', [companyId]);
  await pool.query('DELETE FROM captured_documents WHERE company_id = $1', [companyId]);
  await pool.query('DELETE FROM fraud_alerts WHERE company_id = $1', [companyId]);
  await pool.query('DELETE FROM migration_sessions WHERE company_id = $1', [companyId]);
  await pool.query('DELETE FROM platform_shared.supplier_templates WHERE id = $1', [template]);
  await w.drop();
}, 60000);

const seedDoc = async (vendorName: string) => {
  const id = String((await pool.query(
    `INSERT INTO captured_documents (company_id, file_name, file_type, status, document_type, extracted_data)
     VALUES ($1, 'x.pdf', 'application/pdf', 'extracted', 'supplier_invoice', $2) RETURNING id`,
    [companyId, JSON.stringify({ vendorName, date: '2026-04-02', documentDate: '2026-04-02', invoiceNumber: 'REF-1', referenceNumber: 'REF-1', subtotal: 100, vatAmount: 15, totalAmount: 115, lineItems: [] })])).rows[0].id);
  docs.push(id);
  return id;
};
const seedEvent = async (documentId: string) => String((await pool.query(
  "INSERT INTO capture_events (company_id, channel, status, captured_document_id) VALUES ($1, 'pwa', 'extracted', $2) RETURNING id",
  [companyId, documentId])).rows[0].id);

async function call(handler: unknown, documentId: string, query: Record<string, string> = {}) {
  const state: { status?: number; body?: Record<string, unknown> } = {};
  const res = { status: (s: number) => { state.status = s; return res; }, json: (b: Record<string, unknown>) => { state.body = b; return res; }, setHeader: () => res };
  await inRequestTx(() => (handler as (a: NextApiRequest, b: NextApiResponse) => Promise<void>)(
    { method: 'POST', companyId, user: { id: userId }, query, body: { documentId }, headers: {}, socket: {} } as unknown as NextApiRequest,
    res as unknown as NextApiResponse));
  return state;
}
const data = (s: { body?: Record<string, unknown> }) => (s.body?.data ?? s.body) as Record<string, unknown>;

describe('doc-auto-invoice', () => {
  it('matches a live supplier by the vendor name', async () => {
    expect(data(await call(docAutoInvoice, await seedDoc('Zeta Holdings'))).matched).not.toBe(false);
  });
  it('does not match a merged-away supplier', async () => {
    expect(data(await call(docAutoInvoice, await seedDoc('Qux Traders'))).matched).toBe(false);
  });
});

describe('ai-invoice-pipeline', () => {
  it('sends a vendor named like a merged-away supplier to manual review', async () => {
    const st = await call(aiInvoicePipeline, await seedDoc('Qux Traders'));
    const out = data(st);
    expect(out.status).toBe('manual_review');
    expect(String(out.reason)).toContain('No matching supplier');
  });
});

describe('provisional prediction', () => {
  it('predicts a live supplier from the bank description, never a merged-away one', async () => {
    const liveHit = await predictFromHistory(companyId, { id: crypto.randomUUID(), description: 'EFT ZETA HOLDINGS INV 12', amount: -115 });
    expect(liveHit.supplierId).toBe(live);
    const gone = await predictFromHistory(companyId, { id: crypto.randomUUID(), description: 'EFT QUX TRADERS INV 12', amount: -115 });
    expect(gone.supplierId).not.toBe(mergedAway);
  });
});

describe('capture/[id]/post', () => {
  it('sends a vendor named like a merged-away supplier to manual review', async () => {
    const event = await seedEvent(await seedDoc('Qux Traders'));
    const out = data(await call(postCapture, '', { id: event }));
    expect(out.status).toBe('manual_review');
    expect(String(out.reason)).toContain('No matching supplier');
  });
});

describe('fraud scan', () => {
  it('raises alerts for a live linked supplier, never for a merged-away one', async () => {
    await pool.query("INSERT INTO platform_shared.supplier_templates (id, canonical_name, vat_registration) VALUES ($1, 'Shared Template Co', 'V-CANON')", [template]);
    const linked = await insPlain('Linked Live Co');
    await pool.query("UPDATE suppliers SET platform_template_id = $2, vat_number = 'V-LIVE' WHERE id = $1", [linked, template]);
    await pool.query("UPDATE suppliers SET platform_template_id = $2, vat_number = 'V-GONE' WHERE id = $1", [mergedAway, template]);
    expect((await scanCompanyForFraud(companyId)).created).toBe(1);
    const alerts = (await pool.query('SELECT supplier_id FROM fraud_alerts WHERE company_id = $1', [companyId])).rows.map((r) => String(r.supplier_id));
    expect(alerts).toEqual([linked]);
  });
});

describe('the take-on importers', () => {
  it('importSuppliers does not treat a merged-away supplier as the existing one: the row is imported live', async () => {
    const session = await inRequestTx(() => createSession(companyId, 'sage', userId));
    const result = await inRequestTx(() => importSuppliers(companyId, session.id, [{ name: 'Qux Traders' }], 'skip', userId));
    expect(result).toMatchObject({ imported: 1, skipped: 0 });
    const live = await pool.query("SELECT id FROM suppliers WHERE company_id = $1 AND deleted_at IS NULL AND name = 'Qux Traders'", [companyId]);
    expect(live.rows).toHaveLength(1);
  });

  it('importAPInvoices does not post a bill to a merged-away supplier: the row is reported, nothing imported', async () => {
    // A merged-away supplier no live supplier shares a name with (the import above created a live Qux Traders).
    const gone = await insPlain('Plum Wholesale');
    const survivor = await insPlain('Granite Supplies');
    await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [gone, survivor]);
    await pool.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active, is_system_account)
       VALUES ($1, '3999', 'Opening Balance Equity', 'equity', 'opening_balance_equity', 'credit', true, true)`, [companyId]);
    clearSystemAccountCache(companyId);
    const session = await inRequestTx(() => createSession(companyId, 'sage', userId));
    const row = { invoiceNumber: `NM-${w.tag}`, supplierName: 'Plum Wholesale', invoiceDate: '2026-04-02', dueDate: '2026-05-02', subtotal: 100, taxAmount: 0, totalAmount: 100, amountPaid: 100 };
    const result = await inRequestTx(() => importAPInvoices(companyId, session.id, [row as never], userId));
    expect(result.imported).toBe(0);
    expect(result.errors.map((e) => e.message)).toEqual(['Supplier not found: Plum Wholesale']);
  });
});
