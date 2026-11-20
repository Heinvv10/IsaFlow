/**
 * Goods received notes: their documents and their races (docs/design/mcp-goods-received.md), real PostgreSQL, as app_user.
 * Acceptance items:
 *   5. a delivery note PDF attaches to a note through create_upload_urls -> PUT -> finalize_uploads (and attach_entity_document,
 *      default document type delivery_note); get_goods_received and list_goods_received show it; another company's note is
 *      "Not found" to both attach paths;
 *  10. two creates racing for the same remaining quantity: one succeeds, the other is over_receipt; creates and cancels racing on
 *      one PO never deadlock and leave each PO line's received quantity equal to its live notes' sum.
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
import { dropBillFixture, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { PDF, put, sha } from './helpers/mcpUploadHarness';
import { callTool, dropGrnExtras, dropMaintExtras, grnArgs, poState, refusal, seedQtyPo, type Json } from './helpers/grnHarness';
import { createGoodsReceivedTool as create } from '@/lib/mcp/tools/writeCreateGoodsReceived';
import { cancelGoodsReceivedTool as cancel } from '@/lib/mcp/tools/writeCancelGoodsReceived';
import { getGoodsReceivedTool as getGrn, listGoodsReceivedTool as listGrn } from '@/lib/mcp/tools/goodsReceivedReadTools';
import { attachEntityDocumentTool as attach } from '@/lib/mcp/tools/writeAttachEntityDocument';
import { createUploadUrlsTool as createUrls } from '@/lib/mcp/tools/writeCreateUploadUrls';
import { finalizeUploadsTool as finalize } from '@/lib/mcp/tools/writeFinalizeUploads';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
let f: BillFixture;
let other: BillFixture;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'grn-docs-races');
  other = await seedBillFixture(pool, 'grn-docs-races-other');
}, 60_000);
afterAll(async () => {
  try {
    for (const x of [f, other]) { await dropGrnExtras(pool, x); await dropMaintExtras(pool, x); await dropBillFixture(pool, x); }
  } finally { await pool.end(); }
}, 60_000);

describe('the delivery note (5)', () => {
  it('create_upload_urls -> PUT -> finalize_uploads files it on the note; get and list show it; attach_entity_document defaults to delivery_note', async () => {
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 4, price: 10 }] });
    const grn = String((await callTool(pool, f, create, grnArgs(po, [[0, 4]]))).body.grn_id);
    const bytes = PDF(`delivery ${grn}`);
    const urls = await callTool(pool, f, createUrls, { files: [{
      target: { entity_type: 'goods_received', entity_id: grn }, file_name: 'DN-123.pdf', mime_type: 'application/pdf', size: bytes.length, sha256: sha(bytes),
    }] });
    expect(urls.body, urls.text).toMatchObject({ urls_issued: 1, refused: 0 });
    const upload = (urls.body.uploads as Json[])[0]!;
    expect(await put(String(upload.url), bytes)).toBe(200);
    const done = await callTool(pool, f, finalize, { upload_ids: [upload.upload_id] });
    expect(done.body, done.text).toMatchObject({ finalized: 1, refused: 0 });

    const got = await callTool(pool, f, getGrn, { grn_id: grn });
    expect(got.body).toMatchObject({ documents_total: 1, documents: [expect.objectContaining({ name: expect.stringContaining('DN-123'), document_type: 'delivery_note' })] });

    const second = PDF(`signed ${grn}`);
    const a = await callTool(pool, f, attach, {
      entity_type: 'goods_received', entity_id: grn, file_name: 'signed.pdf', mime_type: 'application/pdf', content: second.toString('base64'),
    });
    expect(a.body, a.text).toMatchObject({ entity_type: 'goods_received', entity_id: grn, document_type: 'delivery_note', duplicate: false });
    expect((await callTool(pool, f, listGrn, { po_id: po.po })).body).toMatchObject({ goods_received_notes: [expect.objectContaining({ id: grn, document_count: 2 })] });
  });

  it('another company\'s note is "Not found" to both attach paths', async () => {
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 1, price: 10 }] });
    const grn = String((await callTool(pool, f, create, grnArgs(po, [[0, 1]]))).body.grn_id);
    const bytes = PDF('foreign');
    const a = await callTool(pool, other, attach, {
      entity_type: 'goods_received', entity_id: grn, file_name: 'x.pdf', mime_type: 'application/pdf', content: bytes.toString('base64'),
    });
    expect(a).toMatchObject({ isError: true, text: 'Not found' });
    const urls = await callTool(pool, other, createUrls, { files: [{
      target: { entity_type: 'goods_received', entity_id: grn }, file_name: 'x.pdf', mime_type: 'application/pdf', size: bytes.length, sha256: sha(bytes),
    }] });
    expect(urls.body).toMatchObject({ urls_issued: 0 });
  });

  it('a user of both companies, working in one, cannot attach to the other\'s note (row security alone admits both)', async () => {
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 1, price: 10 }] });
    const grn = String((await callTool(pool, f, create, grnArgs(po, [[0, 1]]))).body.grn_id);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING", [f.co, other.owner]);
    try {
      const bytes = PDF('two companies');
      const a = await callTool(pool, other, attach, {
        entity_type: 'goods_received', entity_id: grn, file_name: 'x.pdf', mime_type: 'application/pdf', content: bytes.toString('base64'),
      });
      expect(a).toMatchObject({ isError: true, text: 'Not found' });
      const urls = await callTool(pool, other, createUrls, { files: [{
        target: { entity_type: 'goods_received', entity_id: grn }, file_name: 'x.pdf', mime_type: 'application/pdf', size: bytes.length, sha256: sha(bytes),
      }] });
      expect(urls.body).toMatchObject({ urls_issued: 0 });
    } finally {
      await pool.query('DELETE FROM company_users WHERE company_id = $1 AND user_id = $2', [f.co, other.owner]);
    }
  });
});

describe('races (10)', () => {
  it('two creates for the same remaining quantity: one succeeds, the other is over_receipt', async () => {
    for (let round = 0; round < 5; round++) {
      const po = await seedQtyPo(pool, f, { lines: [{ qty: 10, price: 1, received: 4 }], status: 'partially_received' });
      const [a, b] = await Promise.all([callTool(pool, f, create, grnArgs(po, [[0, 6]])), callTool(pool, f, create, grnArgs(po, [[0, 6]]))]);
      const results = [a, b];
      expect(results.filter((r) => !r.isError), `round ${round}`).toHaveLength(1);
      const loser = results.find((r) => r.isError)!;
      expect(refusal(loser.text), `round ${round}`).toMatchObject({ lines: [{ code: 'over_receipt', outstanding: 0, asked: 6 }] });
      expect(await poState(pool, po)).toEqual({ status: 'received', received: [10] });
    }
  });

  it('creates on two POs at once take consecutive numbers (number lock 620), never the same one', async () => {
    for (let round = 0; round < 5; round++) {
      const p1 = await seedQtyPo(pool, f, { lines: [{ qty: 1, price: 1 }] });
      const p2 = await seedQtyPo(pool, f, { lines: [{ qty: 1, price: 1 }] });
      const out = await Promise.all([callTool(pool, f, create, grnArgs(p1, [[0, 1]])), callTool(pool, f, create, grnArgs(p2, [[0, 1]]))]);
      for (const r of out) expect(r.isError, r.text).toBe(false);
      const numbers = out.map((r) => Number(String(r.body.grn_number).slice(4))).sort((a, b) => a - b);
      expect(numbers[1], `round ${round}`).toBe(numbers[0]! + 1);
    }
  });

  it('creates and cancels racing on one PO: no deadlock, no lock timeout, received = the live notes\' sum', async () => {
    const unexpected: string[] = [];
    for (let round = 0; round < 6; round++) {
      const po = await seedQtyPo(pool, f, { lines: [{ qty: 10, price: 1 }, { qty: 10, price: 1 }] });
      const g1 = String((await callTool(pool, f, create, grnArgs(po, [[0, 3], [1, 2]]))).body.grn_id);
      const g2 = String((await callTool(pool, f, create, grnArgs(po, [[1, 4]]))).body.grn_id);
      const ops = [
        callTool(pool, f, cancel, { grn_id: g1, reason: 'race' }),
        callTool(pool, f, create, grnArgs(po, [[0, 7]])),
        callTool(pool, f, cancel, { grn_id: g2, reason: 'race' }),
        callTool(pool, f, create, grnArgs(po, [[1, 6], [0, 1]])),
        callTool(pool, f, cancel, { grn_id: g1, reason: 'race again' }),
      ];
      const settled = await Promise.allSettled(ops);
      settled.forEach((r, k) => { if (r.status === 'rejected') unexpected.push(`round ${round} op ${k}: ${(r.reason as { code?: string }).code ?? ''} ${(r.reason as Error).message}`); });
      const live = (await pool.query(
        `SELECT pi.id, pi.quantity_received::NUMERIC AS q,
                COALESCE((SELECT sum(gi.quantity_received) FROM grn_items gi JOIN goods_received_notes g ON g.id = gi.grn_id
                           WHERE gi.po_item_id = pi.id AND g.status <> 'cancelled'), 0)::NUMERIC AS live
           FROM po_items pi WHERE pi.purchase_order_id = $1`, [po.po])).rows as Array<{ q: string; live: string }>;
      for (const l of live) expect(Number(l.q), `round ${round}`).toBe(Number(l.live));
      const cancels = await pool.query("SELECT count(*)::INT AS n FROM goods_received_notes WHERE id = ANY($1::UUID[]) AND status = 'cancelled'", [[g1, g2]]);
      expect(cancels.rows[0].n, `round ${round}: both notes end cancelled exactly once`).toBe(2);
    }
    expect(unexpected).toEqual([]);
  });
});
