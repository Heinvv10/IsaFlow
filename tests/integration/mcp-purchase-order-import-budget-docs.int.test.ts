/**
 * bulk_create_purchase_orders against the budget and the document store (brief 2026-11-18), real PostgreSQL, as
 * app_user (poImportHarness). Budget: BB-6100 opex at CC1 FT, 1 000 a month (budgetBillFixture).
 *   - Committed counts the open (approved) import only: billed (closed) and cancelled POs commit nothing;
 *   - under block, an open PO over its remaining budget refuses the batch with nothing written (the import is no way
 *     round the Approve action's check); under warn it is created with budget_warnings;
 *   - a PDF attached to an imported PO (attach_entity_document, and create_upload_urls -> PUT -> finalize_uploads) lists
 *     under entity_type purchase_order and shows as has_document; another company's PO is "Not found".
 * Object storage is not run here: vfStorage.uploadFile is stubbed, every database write is real.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

vi.mock('@/services/vfStorageAdapter', () => ({
  vfStorage: { uploadFile: vi.fn(async (_b: Buffer, _a: string, t: string, name: string) => ({ url: `https://files.test/${t}/${name}`, path: `${t}/${name}` })) },
  normalizeStorageUrl: (u: string | null | undefined) => u ?? undefined,
}));

import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { asOwner, callTool, dropPoDocuments, sagePo, type Json } from './helpers/poImportHarness';
import { PDF, put, sha } from './helpers/mcpUploadHarness';
import { bulkCreatePurchaseOrdersTool as create } from '@/lib/mcp/tools/writeBulkPurchaseOrders';
import { listPurchaseOrdersTool as list } from '@/lib/mcp/tools/listPurchaseOrders';
import { attachEntityDocumentTool as attach } from '@/lib/mcp/tools/writeAttachEntityDocument';
import { listDocumentsTool as listDocs } from '@/lib/mcp/tools/listDocuments';
import { createUploadUrlsTool as createUrls } from '@/lib/mcp/tools/writeCreateUploadUrls';
import { finalizeUploadsTool as finalize } from '@/lib/mcp/tools/writeFinalizeUploads';
import { readCommitments } from '@/modules/accounting/services/budgets/remainingCommitted';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;
let other: BillFixture;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'po-import-budget');
  other = await seedBillFixture(pool, 'po-import-budget-other');
}, 60_000);
afterAll(async () => {
  try {
    for (const x of [f, other]) { await dropPoDocuments(pool, x); await dropBillFixture(pool, x); }
  } finally {
    await pool.end();
  }
}, 60_000);

const opexPo = (n: number, status: string, price: number) => sagePo(n, f, { status, acct: f.acc.opex, cc1: f.cc.FT, price });
const idOf = async (n: string) => String((await pool.query('SELECT id FROM purchase_orders WHERE company_id = $1 AND po_number = $2', [f.co, n])).rows[0]?.id ?? '');

describe('committed spend', () => {
  it('counts the open import only; billed and cancelled commit nothing', async () => {
    await setPolicy(pool, f, 'block');
    const r = await callTool(pool, f, create, { purchase_orders: [opexPo(1, 'open', 150), opexPo(2, 'billed', 200), opexPo(3, 'cancelled', 100)] });
    expect(r.isError, r.text).toBe(false);
    const rows = await asOwner(pool, f, () => readCommitments(f.co, [f.acc.opex], '2026-06-01', '2026-06-30', {}));
    expect(rows.map((c) => c.lineTotal)).toEqual([300]);
    const approved = await pool.query('SELECT status, approved_by FROM purchase_orders WHERE id = $1', [await idOf('PO0000001')]);
    expect(approved.rows[0]).toEqual({ status: 'approved', approved_by: f.owner });
  });

  it('under block, an open PO over its remaining budget refuses the batch: nothing is written', async () => {
    // 1 000 budget, 300 committed: 800 more is over.
    const r = await callTool(pool, f, create, { purchase_orders: [opexPo(10, 'billed', 50), opexPo(11, 'open', 400)] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^budget_exceeded: /);
    expect(await idOf('PO0000010')).toBe('');
    expect(await idOf('PO0000011')).toBe('');
    // As a draft it commits nothing and is created.
    const draft = await callTool(pool, f, create, { purchase_orders: [opexPo(11, 'draft', 400)] });
    expect(draft.body).toMatchObject({ created: 1 });
  });

  it('under warn, the over-budget open PO is created and its over lines come back as budget_warnings', async () => {
    await setPolicy(pool, f, 'warn');
    const r = await callTool(pool, f, create, { purchase_orders: [opexPo(12, 'open', 400)] });
    expect(r.isError, r.text).toBe(false);
    expect((r.body.purchase_orders as Json[])[0]!.budget_warnings).toEqual(expect.arrayContaining([expect.stringContaining('BB-6100')]));
  });
});

describe('the PO\'s source PDF', () => {
  it('attach_entity_document files it under entity_type purchase_order; list_documents and has_document see it', async () => {
    const po = await idOf('PO0000001');
    const bytes = PDF('sage po 1');
    const a = await callTool(pool, f, attach, {
      entity_type: 'purchase_order', entity_id: po, file_name: 'PO0000001.pdf', mime_type: 'application/pdf', content: bytes.toString('base64'),
    });
    expect(a.isError, a.text).toBe(false);
    expect(a.body).toMatchObject({ entity_type: 'purchase_order', entity_id: po, document_type: 'purchase_order', duplicate: false });

    const docs = await callTool(pool, f, listDocs, { entity_type: 'purchase_order', entity_id: po });
    expect((docs.body.rows as Json[]).map((d) => d.entity_type)).toEqual(['purchase_order']);
    const listed = await callTool(pool, f, list, { po_number: 'PO0000001' });
    expect((listed.body.purchase_orders as Json[])[0]).toMatchObject({ has_document: true, document_count: 1 });
  });

  it('create_upload_urls -> PUT -> finalize_uploads attaches to a PO with no bytes in either call', async () => {
    const po = await idOf('PO0000002');
    const bytes = PDF('sage po 2');
    const urls = await callTool(pool, f, createUrls, { files: [{
      target: { entity_type: 'purchase_order', entity_id: po }, file_name: 'PO0000002.pdf', mime_type: 'application/pdf',
      size: bytes.length, sha256: sha(bytes),
    }] });
    expect(urls.body).toMatchObject({ urls_issued: 1, refused: 0 });
    const upload = (urls.body.uploads as Json[])[0]!;
    expect(await put(String(upload.url), bytes)).toBe(200);
    const done = await callTool(pool, f, finalize, { upload_ids: [upload.upload_id] });
    expect(done.body, done.text).toMatchObject({ finalized: 1, refused: 0 });
    const docs = await callTool(pool, f, listDocs, { entity_type: 'purchase_order', entity_id: po });
    expect((docs.body.rows as Json[]).map((d) => [d.entity_type, String(d.file_name)])).toEqual([['purchase_order', expect.stringContaining('PO0000002')]]);
  });

  it('another company\'s PO is "Not found" to both attach paths', async () => {
    const po = await idOf('PO0000001');
    const bytes = PDF('foreign');
    const a = await callTool(pool, other, attach, {
      entity_type: 'purchase_order', entity_id: po, file_name: 'x.pdf', mime_type: 'application/pdf', content: bytes.toString('base64'),
    });
    expect(a).toMatchObject({ isError: true, text: 'Not found' });
    const urls = await callTool(pool, other, createUrls, { files: [{
      target: { entity_type: 'purchase_order', entity_id: po }, file_name: 'x.pdf', mime_type: 'application/pdf', size: bytes.length, sha256: sha(bytes),
    }] });
    expect(urls.body).toMatchObject({ urls_issued: 0 });
  });
});
