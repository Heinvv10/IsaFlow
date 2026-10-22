// Retrying a capture read, through the real document-capture-action route (withAuth, CSRF, the commit-then-after-commit
// order) on the disposable fixture DB, with the real job. Storage is an in-memory stand-in (pointer columns are real);
// the VLM reader is controlled per test. Pins: the retry race (a read thought dead that finishes or fails late writes
// nothing), what a retry refuses (posted, rejected, confirmed, being read, unstored, found missing, done, another
// company's), what it accepts (failed, silent), the in-flight cap, and two retries at once.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { objects } from './capture-read-storage.helpers';

const m = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/modules/accounting/services/capture/captureUploadForm', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/capture/captureUploadForm')>()),
  readUploadedDocument: m.read,
}));
vi.mock('@/lib/supabaseStorage', async (orig) => (await import('./capture-read-storage.helpers')).fakeSupabaseStorage(await orig()));

import action from '../../pages/api/accounting/document-capture-action';
import { runCaptureRead } from '@/modules/accounting/services/capture/captureReadJob';
import { retryCaptureRead } from '@/modules/accounting/services/capture/captureReadRetry';
import { GENERIC_READ_ERROR, NOT_STORED_ERROR, STILL_BEING_READ } from '@/modules/accounting/services/capture/captureReadState';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const otherCompany = crypto.randomUUID();
const user = crypto.randomUUID();
const BUCKET = 'captured-documents';
const PDF = Buffer.from('%PDF-1.4 retry fixture');
let token = '';

const extraction = (vendor: string): ExtractedDocument => ({
  documentType: 'invoice', vendorName: vendor, vendorVatNumber: null, vendorAddress: null, vendorBankDetails: null,
  customerName: null, customerVatNumber: null, date: '2026-10-01', dueDate: null, paymentTerms: null,
  referenceNumber: 'INV-RETRY', purchaseOrderRef: null, currency: 'ZAR', subtotal: 100, vatAmount: 15, vatRate: 15,
  totalAmount: 115, lineItems: [], rawText: 'raw', confidence: 0.9, warnings: [], extractionMethod: 'vlm',
});

/** A read the test finishes by hand, so a job can be held mid-flight. */
function deferred() {
  let resolve: (d: ExtractedDocument) => void = () => undefined;
  let reject: (e: Error) => void = () => undefined;
  const promise = new Promise<ExtractedDocument>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

interface Over {
  state?: 'reading' | 'failed' | 'done'; status?: string; posted?: boolean; stored?: boolean; error?: string | null;
  silentMinutes?: number; attempt?: number; owner?: string; vendor?: string | null;
}
async function insertDoc(over: Over = {}): Promise<string> {
  const id = crypto.randomUUID();
  const owner = over.owner ?? company;
  const stored = over.stored !== false;
  await pool.query(
    `INSERT INTO captured_documents(id, company_id, file_name, file_type, document_type, extracted_data, vendor_name, status,
                                    posted_at, read_state, read_error, read_attempt, created_at, read_heartbeat_at,
                                    storage_bucket, storage_path)
     VALUES($1,$2,'retry.pdf','pdf',NULL,'{}'::jsonb,$3,$4, ${over.posted ? 'NOW()' : 'NULL'}, $5,$6,$7,
            NOW() - make_interval(mins => $8), NOW() - make_interval(mins => $8), $9, $10)`,
    [id, owner, over.vendor ?? null, over.status ?? 'pending', over.state ?? 'failed',
      over.error === undefined ? (over.state === 'done' ? null : GENERIC_READ_ERROR) : over.error,
      over.attempt ?? 0, over.silentMinutes ?? 10, stored ? BUCKET : null, stored ? `${owner}/${id}` : null],
  );
  if (stored) objects.set(`${BUCKET}/${owner}/${id}`, PDF);
  return id;
}
const rowOf = async (id: string) => (await pool.query('SELECT * FROM captured_documents WHERE id = $1', [id])).rows[0];

async function retry(id: string) {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST');
  req.url = '/api/accounting/document-capture-action';
  req.body = { id, action: 'retry' };
  const result = response();
  await action(req, result.res);
  return result.state as unknown as { statusCode: number; body: { data?: Record<string, unknown>; error?: { message: string } } };
}
const message = (r: { body: { error?: { message: string } } }) => r.body.error?.message ?? '';

async function purge(): Promise<void> {
  await pool.query('DELETE FROM captured_documents WHERE company_id = ANY($1::uuid[])', [[company, otherCompany]]);
  await pool.query('DELETE FROM company_users WHERE company_id = ANY($1::uuid[])', [[company, otherCompany]]);
  await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[company, otherCompany]]);
  await pool.query('DELETE FROM users WHERE id = $1', [user]);
}

beforeAll(async () => {
  await purge();
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$3),($2,$4)', [company, otherCompany, 'Retry A', 'Retry B']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
  token = await new SignJWT({ sub: user, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
});
beforeEach(() => { m.read.mockReset(); m.read.mockResolvedValue(extraction('Retried Vendor')); });
afterEach(async () => {
  objects.clear();
  await pool.query('DELETE FROM captured_documents WHERE company_id = ANY($1::uuid[])', [[company, otherCompany]]);
});
afterAll(async () => { try { await purge(); } finally { await pool.end(); } }, 60_000);

describe('retry accepted', () => {
  it('a failed row is re-armed (attempt + 1), answered as reading, and the job finishes it from the stored file', async () => {
    const id = await insertDoc({ state: 'failed' });
    const out = await retry(id);
    expect(out.statusCode).toBe(200);
    expect(out.body.data).toMatchObject({ id, readState: 'reading', readError: null, retryable: false });
    expect(JSON.stringify(out.body)).not.toContain(`${company}/${id}`);
    await vi.waitFor(async () => {
      expect(await rowOf(id)).toMatchObject({ read_state: 'done', read_error: null, read_attempt: 1, vendor_name: 'Retried Vendor' });
    }, { timeout: 10_000 });
    expect(m.read).toHaveBeenCalledTimes(1);
    expect(m.read.mock.calls[0]![0].equals(PDF)).toBe(true);
  });

  it('a read gone silent (shown as interrupted) is accepted too', async () => {
    const id = await insertDoc({ state: 'reading', error: null, silentMinutes: 30 });
    expect((await retry(id)).statusCode).toBe(200);
    await vi.waitFor(async () => expect(await rowOf(id)).toMatchObject({ read_state: 'done', read_attempt: 1 }), { timeout: 10_000 });
  });

  it('a failed read keeps what a person typed while it was failed', async () => {
    const id = await insertDoc({ state: 'failed', vendor: 'Typed Vendor' });
    expect((await retry(id)).statusCode).toBe(200);
    await vi.waitFor(async () => expect(await rowOf(id)).toMatchObject({ read_state: 'done', vendor_name: 'Typed Vendor' }), { timeout: 10_000 });
  });
});

describe('retry refused: nothing changes and nothing is read', () => {
  const untouched = async (id: string, before: Record<string, unknown>) => {
    const after = await rowOf(id);
    expect(after).toMatchObject({
      read_state: before.read_state, read_error: before.read_error, read_attempt: before.read_attempt, status: before.status,
    });
    expect(m.read).not.toHaveBeenCalled();
  };

  it.each([
    ['rejected', { status: 'rejected' }],
    ['confirmed', { status: 'reviewed' }],
    ['matched to a bank transaction', { status: 'matched' }],
    ['posted', { posted: true }],
    ['never stored (no pointer)', { stored: false }],
    ['stored file found missing', { error: NOT_STORED_ERROR }],
    ['already read', { state: 'done' as const, error: null }],
  ])('a document that is %s is refused with 400', async (_name, over) => {
    const id = await insertDoc(over as Over);
    const before = await rowOf(id);
    const out = await retry(id);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(message(out)).toContain('cannot be retried');
    await new Promise((r) => setTimeout(r, 150));
    await untouched(id, before);
  });

  it('a read that is alive is refused with 409 "still being read"', async () => {
    const id = await insertDoc({ state: 'reading', error: null, silentMinutes: 0 });
    const before = await rowOf(id);
    const out = await retry(id);
    expect(out.statusCode).toBe(409);
    expect(message(out)).toBe(STILL_BEING_READ);
    await new Promise((r) => setTimeout(r, 150));
    await untouched(id, before);
  });

  it("another company's document is a 404 and is left alone", async () => {
    const id = await insertDoc({ owner: otherCompany });
    const before = await rowOf(id);
    expect((await retry(id)).statusCode).toBe(404);
    await new Promise((r) => setTimeout(r, 150));
    await untouched(id, before);
  });

  it('answers 429 when the company already has 5 reads in flight, and re-arms nothing', async () => {
    for (let i = 0; i < 5; i += 1) await insertDoc({ state: 'reading', error: null, silentMinutes: 0 });
    const id = await insertDoc({ state: 'failed' });
    const before = await rowOf(id);
    const out = await retry(id);
    expect(out.statusCode).toBe(429);
    expect(message(out)).toContain('Too many documents are being read');
    await untouched(id, before);
  });
});

describe('the retry race: a read thought dead that is only slow', () => {
  /** Start the first attempt's job and hold its read; the row then goes silent, and a retry starts attempt 1. */
  async function slowFirstAttempt() {
    const first = deferred();
    const second = deferred();
    m.read.mockReset();
    m.read.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const id = await insertDoc({ state: 'reading', error: null, silentMinutes: 0, attempt: 0 });
    const oldJob = runCaptureRead(company, id, 0);
    await vi.waitFor(() => expect(m.read).toHaveBeenCalledTimes(1));
    await pool.query("UPDATE captured_documents SET read_heartbeat_at = NOW() - interval '10 minutes' WHERE id = $1", [id]);
    expect((await retry(id)).statusCode).toBe(200);
    await vi.waitFor(() => expect(m.read).toHaveBeenCalledTimes(2));
    expect(await rowOf(id)).toMatchObject({ read_state: 'reading', read_attempt: 1 });
    return { id, oldJob, first, second };
  }

  it('the old attempt finishing late writes nothing: not the figures, not "done"', async () => {
    const { id, oldJob, first, second } = await slowFirstAttempt();
    first.resolve(extraction('Old Attempt Vendor'));
    await oldJob;
    expect(await rowOf(id)).toMatchObject({ read_state: 'reading', read_attempt: 1, vendor_name: null, document_type: null, total_amount: null });
    second.resolve(extraction('New Attempt Vendor'));
    await vi.waitFor(async () => expect(await rowOf(id)).toMatchObject({ read_state: 'done', vendor_name: 'New Attempt Vendor' }), { timeout: 10_000 });
  });

  it('the old attempt failing late does not fail the row its retry is reading', async () => {
    const { id, oldJob, first, second } = await slowFirstAttempt();
    first.reject(new Error('vlm timed out'));
    await oldJob;
    expect(await rowOf(id)).toMatchObject({ read_state: 'reading', read_error: null, read_attempt: 1 });
    second.resolve(extraction('New Attempt Vendor'));
    await vi.waitFor(async () => expect(await rowOf(id)).toMatchObject({ read_state: 'done', vendor_name: 'New Attempt Vendor' }), { timeout: 10_000 });
  });

  it('the old attempt finishing after the new one overwrites nothing', async () => {
    const { id, oldJob, first, second } = await slowFirstAttempt();
    second.resolve(extraction('New Attempt Vendor'));
    await vi.waitFor(async () => expect(await rowOf(id)).toMatchObject({ read_state: 'done' }), { timeout: 10_000 });
    first.resolve(extraction('Old Attempt Vendor'));
    await oldJob;
    expect(await rowOf(id)).toMatchObject({ read_state: 'done', vendor_name: 'New Attempt Vendor', read_attempt: 1 });
  });

  it('the old attempt failing after the new one finished does not fail the done row', async () => {
    const { id, oldJob, first, second } = await slowFirstAttempt();
    second.resolve(extraction('New Attempt Vendor'));
    await vi.waitFor(async () => expect(await rowOf(id)).toMatchObject({ read_state: 'done' }), { timeout: 10_000 });
    first.reject(new Error('late'));
    await oldJob;
    expect(await rowOf(id)).toMatchObject({ read_state: 'done', read_error: null, vendor_name: 'New Attempt Vendor' });
  });
});

// Outside a request the service runs as the pool role with NO row-level security, so the company predicates are the only
// tenancy there is; and `charge` runs between the eligibility read and the re-arm, so a row can be changed exactly there.
describe('the re-arm re-checks the row at the moment it writes', () => {
  const changeBetween = (id: string, sqlText: string) => retryCaptureRead(company, id, async () => {
    await pool.query(sqlText, [id]);
    return true;
  });

  it.each([
    ['posted', "UPDATE captured_documents SET posted_at = NOW() WHERE id = $1", 'not_retryable'],
    ['rejected', "UPDATE captured_documents SET status = 'rejected' WHERE id = $1", 'not_retryable'],
    ['confirmed', "UPDATE captured_documents SET status = 'reviewed' WHERE id = $1", 'not_retryable'],
    ['its file unlinked', "UPDATE captured_documents SET storage_path = NULL WHERE id = $1", 'not_retryable'],
    ['its file found missing', `UPDATE captured_documents SET read_error = '${NOT_STORED_ERROR}' WHERE id = $1`, 'not_retryable'],
    ['read by another retry', "UPDATE captured_documents SET read_state = 'reading', read_error = NULL, read_heartbeat_at = NOW(), read_attempt = read_attempt + 1 WHERE id = $1", 'being_read'],
    ['read to the end', "UPDATE captured_documents SET read_state = 'done', read_error = NULL WHERE id = $1", 'not_retryable'],
  ])('a row %s between the check and the write is not re-armed', async (_name, change, reason) => {
    const id = await insertDoc({ state: 'failed' });
    const before = await rowOf(id);
    expect(await changeBetween(id, change)).toEqual({ ok: false, reason });
    const after = await rowOf(id);
    expect(after.read_attempt).toBe(reason === 'being_read' ? before.read_attempt + 1 : before.read_attempt);
    expect(after.read_state).not.toBe(reason === 'being_read' ? 'failed' : 'reading');
    await new Promise((r) => setTimeout(r, 150));
    expect(m.read).not.toHaveBeenCalled();
  });

  it("does not see another company's row at all", async () => {
    const id = await insertDoc({ state: 'failed', owner: otherCompany });
    const before = await rowOf(id);
    expect(await retryCaptureRead(company, id, async () => true)).toEqual({ ok: false, reason: 'missing' });
    expect(await rowOf(id)).toMatchObject({ read_state: before.read_state, read_attempt: before.read_attempt });
  });

  it('counts only its own company\'s reads towards the cap', async () => {
    for (let i = 0; i < 5; i += 1) await insertDoc({ state: 'reading', error: null, silentMinutes: 0, owner: otherCompany });
    const id = await insertDoc({ state: 'failed' });
    expect(await retryCaptureRead(company, id, async () => true)).toMatchObject({ ok: true });
  });

  it('does not count reads that went silent towards the cap', async () => {
    for (let i = 0; i < 5; i += 1) await insertDoc({ state: 'reading', error: null, silentMinutes: 30 });
    const id = await insertDoc({ state: 'failed' });
    expect(await retryCaptureRead(company, id, async () => true)).toMatchObject({ ok: true });
  });
});

describe('two retries at once', () => {
  it('exactly one wins: one 200, one 409 (the winner is still reading), attempt 1, one read', async () => {
    const hold = deferred();
    m.read.mockReset();
    m.read.mockImplementation(() => hold.promise);
    const id = await insertDoc({ state: 'failed' });
    const [a, b] = await Promise.all([retry(id), retry(id)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    hold.resolve(extraction('Retried Vendor'));
    await vi.waitFor(async () => expect(await rowOf(id)).toMatchObject({ read_state: 'done', read_attempt: 1 }), { timeout: 10_000 });
    expect(m.read).toHaveBeenCalledTimes(1);
  });
});

describe('a missing file is not retried into a loop', () => {
  it('a pointer whose object is gone ends not stored, and the next retry is refused', async () => {
    const id = await insertDoc({ state: 'failed' });
    objects.clear();
    expect((await retry(id)).statusCode).toBe(200);
    await vi.waitFor(async () => expect(await rowOf(id)).toMatchObject({ read_state: 'failed', read_error: NOT_STORED_ERROR }), { timeout: 10_000 });
    expect(m.read).not.toHaveBeenCalled();
    const again = await retry(id);
    expect(again.statusCode).toBe(400);
    expect(await rowOf(id)).toMatchObject({ read_attempt: 1, read_error: NOT_STORED_ERROR });
  });

  it('a Storage outage ends failed with the generic message and stays retryable', async () => {
    const id = await insertDoc({ state: 'failed' });
    m.read.mockRejectedValue(new Error('vlm down'));
    expect((await retry(id)).statusCode).toBe(200);
    await vi.waitFor(async () => expect(await rowOf(id)).toMatchObject({ read_state: 'failed', read_error: GENERIC_READ_ERROR, read_attempt: 1 }), { timeout: 10_000 });
    m.read.mockResolvedValue(extraction('Third Time'));
    expect((await retry(id)).statusCode).toBe(200);
    await vi.waitFor(async () => expect(await rowOf(id)).toMatchObject({ read_state: 'done', read_attempt: 2, vendor_name: 'Third Time' }), { timeout: 10_000 });
  });
});
