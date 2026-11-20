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
import { predictFromHistory } from '@/modules/accounting/services/capture/provisionalPrediction';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { sageMergedWorld } from './helpers/sageMergedSupplierWorld';

assertDisposable();
const w = sageMergedWorld('nomatch');
const { pool, companyId, userId, inRequestTx, insPlain } = w;

let live = '';
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
  await pool.query('DELETE FROM captured_documents WHERE company_id = $1', [companyId]);
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

async function call(handler: unknown, documentId: string) {
  const state: { status?: number; body?: Record<string, unknown> } = {};
  const res = { status: (s: number) => { state.status = s; return res; }, json: (b: Record<string, unknown>) => { state.body = b; return res; }, setHeader: () => res };
  await inRequestTx(() => (handler as (a: NextApiRequest, b: NextApiResponse) => Promise<void>)(
    { method: 'POST', companyId, user: { id: userId }, query: {}, body: { documentId }, headers: {}, socket: {} } as unknown as NextApiRequest,
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
