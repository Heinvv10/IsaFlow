/**
 * Intercompany P2, the sealed PDF travels with the message. The sender's approval seals its invoice PDF into storage (an in-memory
 * stand-in for the bucket here: CI has no Storage); the receiver's accept copies it from under the SENDER's prefix, checks its hash
 * against the message, stores it under the RECEIVER's prefix as a captured document and points the draft bill at it
 * (`source_document_id`). A file that was altered or is gone costs the draft its document, never the accept.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const store = vi.hoisted(() => new Map<string, Buffer>());
vi.mock('@supabase/storage-js', () => ({
  StorageClient: class {
    createBucket() { return { error: null }; }
    from(bucket: string) {
      return {
        upload: async (path: string, body: Buffer) => { store.set(`${bucket}/${path}`, Buffer.from(body)); return { error: null }; },
        download: async (path: string) => {
          const b = store.get(`${bucket}/${path}`);
          return b ? { data: new Blob([b]), error: null } : { data: null, error: { message: 'Object not found', status: 404, statusCode: '404' } };
        },
        remove: async (paths: string[]) => { for (const p of paths) store.delete(`${bucket}/${p}`); return { error: null }; },
      };
    }
  },
}));

import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { CAPTURED_DOCS_BUCKET, CUSTOMER_INVOICES_BUCKET } from '../../../src/lib/supabaseStorage';
import { clearMirrorRows, co, connect, dataOf, errorOf, inbox, mirrorCleanup, mirrorSetup, sentInvoice, U } from './mirror.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
beforeAll(async () => {
  process.env.SUPABASE_URL = 'http://storage.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
  await mirrorSetup(pool);
}, 60000);
afterAll(() => mirrorCleanup(pool), 60000);
beforeEach(async () => { store.clear(); await clearMirrorRows(pool); await connect(pool); });

const pdfOf = (message: { payload: { pdf: { path: string; sha256: string } | null } }) => message.payload.pdf!;
const billOf = async () => (await pool.query('SELECT * FROM supplier_invoices WHERE company_id = $1', [co.B])).rows[0];
const receiverObjects = () => [...store.keys()].filter((k) => k.startsWith(`${CAPTURED_DOCS_BUCKET}/${co.B}/`));

describe('the sender seals, the receiver copies', () => {
  it('the message carries the sealed PDF; accept stores a copy under the receiver\'s prefix and the draft bill points at it', async () => {
    const { id, message } = await sentInvoice(pool);
    const pdf = pdfOf(message);
    expect(pdf.path.startsWith(`${co.A}/`)).toBe(true);
    const sealed = store.get(`${CUSTOMER_INVOICES_BUCKET}/${pdf.path}`)!;
    expect(sealed.length).toBeGreaterThan(100);

    const res = await inbox.accept(U.b, co.B, id);
    expect(res.state.statusCode, errorOf(res)).toBe(200);
    expect(dataOf<{ pdfCopied: boolean }>(res).pdfCopied).toBe(true);
    const bill = await billOf();
    expect(bill.source_document_id).not.toBeNull();
    const doc = (await pool.query('SELECT * FROM captured_documents WHERE id = $1', [bill.source_document_id])).rows[0];
    expect(doc).toMatchObject({ company_id: co.B, matched_invoice_id: bill.id, storage_bucket: CAPTURED_DOCS_BUCKET, raw_bytes_sha256: pdf.sha256 });
    expect(String(doc.storage_path).startsWith(`${co.B}/`)).toBe(true);
    expect(store.get(`${CAPTURED_DOCS_BUCKET}/${doc.storage_path}`)!.equals(sealed)).toBe(true);
    expect(store.has(`${CUSTOMER_INVOICES_BUCKET}/${pdf.path}`)).toBe(true); // the sender's own file is not moved or touched
  });

  it('an altered file (it no longer hashes to the message): the accept still succeeds, without a document and without a stored copy', async () => {
    const { id, message } = await sentInvoice(pool);
    store.set(`${CUSTOMER_INVOICES_BUCKET}/${pdfOf(message).path}`, Buffer.from('not the sealed invoice'));
    const res = await inbox.accept(U.b, co.B, id);
    expect(res.state.statusCode, errorOf(res)).toBe(200);
    expect(dataOf<{ pdfCopied: boolean }>(res).pdfCopied).toBe(false);
    expect((await billOf()).source_document_id).toBeNull();
    expect(receiverObjects()).toHaveLength(0);
    expect(Number((await pool.query('SELECT count(*) AS n FROM captured_documents WHERE company_id = $1', [co.B])).rows[0].n)).toBe(0);
  });

  it('a file that is gone: the accept still succeeds, without a document', async () => {
    const { id, message } = await sentInvoice(pool);
    store.delete(`${CUSTOMER_INVOICES_BUCKET}/${pdfOf(message).path}`);
    const res = await inbox.accept(U.b, co.B, id);
    expect(res.state.statusCode, errorOf(res)).toBe(200);
    expect(dataOf<{ pdfCopied: boolean }>(res).pdfCopied).toBe(false);
    expect((await billOf()).source_document_id).toBeNull();
  });
});
