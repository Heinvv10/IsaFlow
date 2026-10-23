// POST /api/accounting/document-capture through the real withAuth chain on the disposable fixture DB: the response is
// 201 with the row 'reading' (not yet extracted), and the read runs only AFTER the request's COMMIT, filling the row
// that the committed insert made visible to the job's own connection. The upload is STORED before the answer (hash, size,
// pointer; Storage is an in-memory stand-in) and the job reads it back from there. A rejected-row race is covered in
// capture-read-state.int.test.ts.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { objects } from './capture-read-storage.helpers';

const m = vi.hoisted(() => ({ read: vi.fn() }));
const PDF = Buffer.from('%PDF-1.4\n%fixture');
vi.mock('@/modules/accounting/services/capture/captureUploadForm', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/capture/captureUploadForm')>()),
  parseUploadForm: async () => ({ files: { file: { originalFilename: 'upload.pdf', mimetype: 'application/pdf', size: PDF.length } } }),
  uploadedBuffer: () => PDF,
  readUploadedDocument: m.read,
}));

vi.mock('@/lib/supabaseStorage', async (orig) => (await import('./capture-read-storage.helpers')).fakeSupabaseStorage(await orig()));

import route from '../../pages/api/accounting/document-capture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const user = crypto.randomUUID();

const extraction = (): ExtractedDocument => ({
  documentType: 'invoice', vendorName: 'After Commit Vendor', vendorVatNumber: null, vendorAddress: null, vendorBankDetails: null,
  customerName: null, customerVatNumber: null, date: '2026-10-01', dueDate: null, paymentTerms: null,
  referenceNumber: 'INV-AC', purchaseOrderRef: null, currency: 'ZAR', subtotal: 100, vatAmount: 15, vatRate: 15,
  totalAmount: 115, lineItems: [], rawText: 'raw', confidence: 0.9, warnings: [], extractionMethod: 'vlm',
});

async function purge(): Promise<void> {
  await pool.query('DELETE FROM captured_documents WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM companies WHERE id=$1', [company]);
  await pool.query('DELETE FROM users WHERE id=$1', [user]);
}

beforeAll(async () => {
  await purge();
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'Capture AC']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
});
afterAll(async () => { try { await purge(); } finally { await pool.end(); } }, 60_000);

describe('document-capture POST: the read runs after COMMIT', () => {
  it('answers 201 with a reading row, then the job fills the committed row', async () => {
    let release: (d: ExtractedDocument) => void = () => undefined;
    m.read.mockImplementation(() => new Promise<ExtractedDocument>((resolve) => { release = resolve; }));
    const token = await new SignJWT({ sub: user, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
    const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST');
    req.url = '/api/accounting/document-capture';
    const result = response();
    await route(req, result.res);

    expect(result.state.statusCode).toBe(201);
    const { document } = (result.state.body as { data: { document: { id: string; readState: string; extractedData: unknown } } }).data;
    expect(document).toMatchObject({ readState: 'reading', extractedData: {} });
    expect(Object.keys((result.state.body as { data: object }).data)).toEqual(['document']);

    // The job started after COMMIT: the row is visible to this separate connection, still reading.
    await vi.waitFor(() => expect(m.read).toHaveBeenCalledTimes(1));
    const before = (await pool.query('SELECT read_state, vendor_name FROM captured_documents WHERE id=$1', [document.id])).rows[0];
    expect(before).toEqual({ read_state: 'reading', vendor_name: null });

    // The upload was stored before the answer: the object is there and the row carries its hash, size and pointer.
    const stored = (await pool.query(
      'SELECT storage_bucket, storage_path, raw_bytes_sha256, raw_bytes_size, read_attempt FROM captured_documents WHERE id=$1', [document.id])).rows[0];
    expect(stored).toMatchObject({
      storage_bucket: 'captured-documents', storage_path: `${company}/${document.id}`, raw_bytes_size: PDF.length, read_attempt: 0,
    });
    expect(stored.raw_bytes_sha256).toBe(createHash('sha256').update(PDF).digest('hex'));
    expect(objects.get(`captured-documents/${company}/${document.id}`)?.equals(PDF)).toBe(true);
    expect(m.read.mock.calls[0]![0].equals(PDF)).toBe(true);

    release(extraction());
    await vi.waitFor(async () => {
      const row = (await pool.query('SELECT read_state, vendor_name, total_amount FROM captured_documents WHERE id=$1', [document.id])).rows[0];
      expect(row).toMatchObject({ read_state: 'done', vendor_name: 'After Commit Vendor' });
      expect(Number(row.total_amount)).toBe(115);
    }, { timeout: 10_000 });
  });
});
