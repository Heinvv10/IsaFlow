// Migration 909 and the capture read job against real PostgreSQL (the disposable fixture DB): the read columns and
// their CHECK exist, a pending row 'reading' is filled by the job, and a row a person rejected, posted or typed
// into while it was being read is never overwritten (the job only stops it showing "reading"). The job reads the
// upload from Storage (an in-memory stand-in; the pointer columns are real) and every write is fenced on read_attempt.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { createHash } from 'node:crypto';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { objects } from './capture-read-storage.helpers';

const m = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/modules/accounting/services/capture/captureUploadForm', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/capture/captureUploadForm')>()),
  readUploadedDocument: m.read,
}));
vi.mock('@/lib/supabaseStorage', async (orig) => (await import('./capture-read-storage.helpers')).fakeSupabaseStorage(await orig()));

import { runCaptureRead } from '@/modules/accounting/services/capture/captureReadJob';
import { mapCapturedDocumentRow } from '@/modules/accounting/services/capture/capturedDocumentMapper';
import { GENERIC_READ_ERROR, NOT_STORED_ERROR, STALE_READ_ERROR } from '@/modules/accounting/services/capture/captureReadState';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const companyA = crypto.randomUUID();
const companyB = crypto.randomUUID();
const BUF = Buffer.from('%PDF-1.4 fixture');
const BUCKET = 'captured-documents';

const extraction = (): ExtractedDocument => ({
  documentType: 'invoice', vendorName: 'Read Vendor', vendorVatNumber: null, vendorAddress: null, vendorBankDetails: null,
  customerName: null, customerVatNumber: null, date: '2026-10-01', dueDate: null, paymentTerms: null,
  referenceNumber: 'INV-READ', purchaseOrderRef: null, currency: 'ZAR', subtotal: 100, vatAmount: 15, vatRate: 15,
  totalAmount: 115, lineItems: [], rawText: 'raw', confidence: 0.9, warnings: [], extractionMethod: 'vlm',
});

async function insertReading(
  over: { status?: string; vendor?: string | null; postedAt?: boolean; company?: string; silentMinutes?: number; stored?: boolean; attempt?: number } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO captured_documents(id, company_id, file_name, file_type, document_type, extracted_data, vendor_name,
                                    status, posted_at, read_state, created_at, storage_bucket, storage_path, read_attempt)
     VALUES($1, $2, 'read.pdf', 'pdf', NULL, '{}'::jsonb, $3, $4, ${over.postedAt ? 'NOW()' : 'NULL'}, 'reading',
            NOW() - make_interval(mins => $5), $6, $7, $8)`,
    [id, over.company ?? companyA, over.vendor ?? null, over.status ?? 'pending', over.silentMinutes ?? 0,
      over.stored === false ? null : BUCKET, over.stored === false ? null : `${over.company ?? companyA}/${id}`, over.attempt ?? 0],
  );
  if (over.stored !== false) objects.set(`${BUCKET}/${over.company ?? companyA}/${id}`, BUF);
  return id;
}
const rowOf = async (id: string) => (await pool.query('SELECT * FROM captured_documents WHERE id = $1', [id])).rows[0];

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$3),($2,$4)', [companyA, companyB, 'Read A', 'Read B']);
});
beforeEach(() => { m.read.mockReset(); m.read.mockResolvedValue(extraction()); });
afterEach(() => { objects.clear(); });
afterAll(async () => {
  try {
    await pool.query('DELETE FROM captured_documents WHERE company_id = ANY($1::uuid[])', [[companyA, companyB]]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[companyA, companyB]]);
  } finally { await pool.end(); }
}, 60_000);

describe('migration 909_captured_document_read_state', () => {
  it('adds the three read columns, NOT NULL read_state defaulting to done', async () => {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_name = 'captured_documents' AND column_name IN ('read_state','read_error','read_heartbeat_at')
       ORDER BY column_name`);
    expect(rows.map((r) => r.column_name)).toEqual(['read_error', 'read_heartbeat_at', 'read_state']);
    const state = rows.find((r) => r.column_name === 'read_state');
    expect(state).toMatchObject({ data_type: 'text', is_nullable: 'NO' });
    expect(state.column_default).toContain("'done'");
    expect(rows.find((r) => r.column_name === 'read_heartbeat_at').data_type).toBe('timestamp with time zone');
  });

  it("a row inserted without the column (every other inserter) is 'done'", async () => {
    const id = crypto.randomUUID();
    await pool.query(`INSERT INTO captured_documents(id, company_id, file_name, file_type) VALUES($1,$2,'x.pdf','pdf')`, [id, companyA]);
    expect((await rowOf(id)).read_state).toBe('done');
  });

  it("has the CHECK: only 'reading', 'done' and 'failed' are accepted", async () => {
    const { rows } = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'captured_documents_read_state_check'`);
    expect(rows).toHaveLength(1);
    await expect(pool.query(
      `INSERT INTO captured_documents(id, company_id, file_name, file_type, read_state) VALUES($1,$2,'x.pdf','pdf','bogus')`,
      [crypto.randomUUID(), companyA],
    )).rejects.toThrow(/captured_documents_read_state_check/);
  });
});

describe('migration 921_captured_document_read_attempt', () => {
  it('adds read_attempt, NOT NULL INTEGER defaulting to 0', async () => {
    const { rows } = await pool.query(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_name = 'captured_documents' AND column_name = 'read_attempt'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ data_type: 'integer', is_nullable: 'NO' });
    expect(rows[0].column_default).toContain('0');
  });

  it('a row inserted without the column (every other inserter) has attempt 0', async () => {
    const id = crypto.randomUUID();
    await pool.query(`INSERT INTO captured_documents(id, company_id, file_name, file_type) VALUES($1,$2,'x.pdf','pdf')`, [id, companyA]);
    expect((await rowOf(id)).read_attempt).toBe(0);
  });
});

describe('runCaptureRead against the database', () => {
  it('fills a pending reading row and finishes it', async () => {
    const id = await insertReading();
    await runCaptureRead(companyA, id, 0);
    const row = await rowOf(id);
    expect(row).toMatchObject({
      read_state: 'done', read_error: null, status: 'pending', document_type: 'invoice', vendor_name: 'Read Vendor',
      reference_number: 'INV-READ',
    });
    expect(Number(row.total_amount)).toBe(115);
    expect(Number(row.vat_amount)).toBe(15);
    expect(row.extracted_data).toMatchObject({ vendorName: 'Read Vendor', totalAmount: 115 });
    expect(row.read_heartbeat_at).not.toBeNull();
  });

  it('does not overwrite a row a person rejected meanwhile: only read_state moves to done', async () => {
    const id = await insertReading({ status: 'rejected' });
    await runCaptureRead(companyA, id, 0);
    const row = await rowOf(id);
    expect(row).toMatchObject({ read_state: 'done', status: 'rejected', vendor_name: null, document_type: null, total_amount: null });
    expect(row.extracted_data).toEqual({});
  });

  it('does not overwrite a row that was posted meanwhile', async () => {
    const id = await insertReading({ postedAt: true, vendor: 'Posted Vendor' });
    await runCaptureRead(companyA, id, 0);
    const row = await rowOf(id);
    expect(row).toMatchObject({ read_state: 'done', vendor_name: 'Posted Vendor', total_amount: null });
    expect(row.extracted_data).toEqual({});
    expect(row.posted_at).not.toBeNull();
  });

  it('does not overwrite a row a person confirmed (reviewed) while it was read', async () => {
    const id = await insertReading({ status: 'reviewed', vendor: 'Confirmed Vendor' });
    await runCaptureRead(companyA, id, 0);
    const row = await rowOf(id);
    expect(row).toMatchObject({ read_state: 'done', status: 'reviewed', vendor_name: 'Confirmed Vendor', total_amount: null });
    expect(row.extracted_data).toEqual({});
  });

  it('does not let a late result land on a row already shown as interrupted: it ends failed, data untouched', async () => {
    const id = await insertReading({ silentMinutes: 30 });
    await runCaptureRead(companyA, id, 0);
    const row = await rowOf(id);
    expect(row).toMatchObject({
      read_state: 'failed', read_error: STALE_READ_ERROR, status: 'pending', vendor_name: null, document_type: null, total_amount: null,
    });
    expect(row.extracted_data).toEqual({});
  });

  it('writes a row whose last sign of life is just inside the limit', async () => {
    const id = await insertReading({ silentMinutes: 4 });
    await runCaptureRead(companyA, id, 0);
    expect(await rowOf(id)).toMatchObject({ read_state: 'done', vendor_name: 'Read Vendor' });
  });

  it('a date the read garbled becomes NULL and the rest of the read is still saved', async () => {
    m.read.mockResolvedValue({ ...extraction(), date: '2026-13-45' });
    const id = await insertReading();
    await runCaptureRead(companyA, id, 0);
    const row = await rowOf(id);
    expect(row).toMatchObject({ read_state: 'done', document_date: null, vendor_name: 'Read Vendor' });
    expect(row.extracted_data).toMatchObject({ date: '2026-13-45' });
  });

  it('lets a value a person typed win over the read value, and fills the rest', async () => {
    const id = await insertReading({ vendor: 'Typed Vendor' });
    await runCaptureRead(companyA, id, 0);
    const row = await rowOf(id);
    expect(row.vendor_name).toBe('Typed Vendor');
    expect(Number(row.total_amount)).toBe(115);
    expect(row.extracted_data).toMatchObject({ vendorName: 'Read Vendor' });
  });

  it('records a failed read with the generic message and keeps the row pending', async () => {
    m.read.mockRejectedValue(new Error('vlm unreachable'));
    const id = await insertReading();
    await runCaptureRead(companyA, id, 0);
    expect(await rowOf(id)).toMatchObject({ read_state: 'failed', read_error: GENERIC_READ_ERROR, status: 'pending', vendor_name: null });
  });

  it("never touches another company's row, even with the right document id", async () => {
    const id = await insertReading({ company: companyB });
    await runCaptureRead(companyA, id, 0);
    expect(await rowOf(id)).toMatchObject({ read_state: 'reading', vendor_name: null });
  });

  it('reads the stored bytes by the stored file type and hands them to the reader', async () => {
    const id = await insertReading();
    await runCaptureRead(companyA, id, 0);
    expect(m.read).toHaveBeenCalledWith(BUF, 'application/pdf');
  });

  it('a row with no stored file ends failed as not stored, and nothing is read', async () => {
    const id = await insertReading({ stored: false });
    await runCaptureRead(companyA, id, 0);
    expect(await rowOf(id)).toMatchObject({ read_state: 'failed', read_error: NOT_STORED_ERROR, vendor_name: null });
    expect(m.read).not.toHaveBeenCalled();
  });

  it('a pointer whose object is gone ends failed as not stored too', async () => {
    const id = await insertReading();
    objects.clear();
    await runCaptureRead(companyA, id, 0);
    expect(await rowOf(id)).toMatchObject({ read_state: 'failed', read_error: NOT_STORED_ERROR });
    expect(m.read).not.toHaveBeenCalled();
  });

  it('bytes that match the recorded sha256 are read; bytes that do not fail the read, retryable (a truncated download)', async () => {
    const good = await insertReading();
    await pool.query('UPDATE captured_documents SET raw_bytes_sha256 = $2 WHERE id = $1', [good, createHash('sha256').update(BUF).digest('hex')]);
    await runCaptureRead(companyA, good, 0);
    expect(await rowOf(good)).toMatchObject({ read_state: 'done', vendor_name: 'Read Vendor' });

    m.read.mockClear();
    const bad = await insertReading();
    await pool.query('UPDATE captured_documents SET raw_bytes_sha256 = $2 WHERE id = $1', [bad, createHash('sha256').update('another file').digest('hex')]);
    await runCaptureRead(companyA, bad, 0);
    const row = await rowOf(bad);
    expect(row).toMatchObject({ read_state: 'failed', read_error: GENERIC_READ_ERROR, vendor_name: null });
    expect(m.read).not.toHaveBeenCalled();
    // still retryable: the stored file is there, only this download did not match
    expect(mapCapturedDocumentRow(row)).toMatchObject({ readState: 'failed', retryable: true });
  });

  it('a job holding an old attempt writes nothing to a row that moved on: not the save, not the failure, not the finish', async () => {
    const saved = await insertReading({ attempt: 1 });
    await runCaptureRead(companyA, saved, 0);
    expect(await rowOf(saved)).toMatchObject({ read_state: 'reading', read_attempt: 1, vendor_name: null });
    m.read.mockRejectedValue(new Error('late failure'));
    await runCaptureRead(companyA, saved, 0);
    expect(await rowOf(saved)).toMatchObject({ read_state: 'reading', read_error: null, read_attempt: 1 });
    const rejected = await insertReading({ attempt: 1, status: 'rejected' });
    m.read.mockResolvedValue(extraction());
    await runCaptureRead(companyA, rejected, 0);
    expect(await rowOf(rejected)).toMatchObject({ read_state: 'reading', read_attempt: 1 });
  });

  it('does not touch a row that is not reading', async () => {
    const id = await insertReading();
    await pool.query("UPDATE captured_documents SET read_state = 'failed', read_error = 'x' WHERE id = $1", [id]);
    await runCaptureRead(companyA, id, 0);
    expect(await rowOf(id)).toMatchObject({ read_state: 'failed', read_error: 'x', vendor_name: null });
  });
});
