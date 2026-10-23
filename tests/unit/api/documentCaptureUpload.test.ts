/**
 * POST /api/accounting/document-capture saves the upload as a 'reading' row, STORES the bytes (as /capture/upload does)
 * and answers at once; the read runs from Storage after COMMIT (runAfterCommit). GET maps the read state, reporting a read gone silent for 5 minutes as failed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest } from 'next';

const m = vi.hoisted(() => ({
  sql: vi.fn(),
  runAfterCommit: vi.fn(),
  runCaptureRead: vi.fn(),
  rateLimit: vi.fn(),
  uploadLimit: vi.fn(),
  parse: vi.fn(),
  bufferOf: vi.fn(),
  info: vi.fn(),
  store: vi.fn(),
}));
vi.mock('@/lib/neon', () => ({ sql: m.sql }));
vi.mock('@/lib/logger', () => ({ log: { info: m.info, warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/documentStorage', async (orig) => ({
  ...(await orig<typeof import('@/lib/documentStorage')>()),
  storeCapturedBytes: m.store,
}));
vi.mock('@/lib/afterCommit', () => ({ runAfterCommit: m.runAfterCommit }));
vi.mock('@/lib/rateLimit', () => ({ checkAiRateLimit: m.rateLimit, checkRateLimit: m.uploadLimit }));
vi.mock('@/modules/accounting/services/capture/captureReadJob', () => ({ runCaptureRead: m.runCaptureRead }));
vi.mock('@/modules/accounting/services/capture/captureUploadForm', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/capture/captureUploadForm')>()),
  parseUploadForm: m.parse,
  uploadedBuffer: m.bufferOf,
}));

import { sha256 } from '@/lib/documentStorage';
import handler from '../../../pages/api/accounting/document-capture';

const CO = 'aaaaaaaa-0000-4000-8000-000000000001';
const USER = 'uuuuuuuu-0000-4000-8000-000000000001';
const DOC = '11111111-1111-4111-8111-111111111111';
const PDF = Buffer.from('%PDF-1.4\n%test');
const file = (over: Record<string, unknown> = {}) => ({ originalFilename: 'inv.pdf', mimetype: 'application/pdf', size: PDF.length, ...over });

const insertedRow = (over: Record<string, unknown> = {}) => ({
  id: DOC, company_id: CO, file_name: 'inv.pdf', file_type: 'pdf', file_size: PDF.length, document_type: null,
  extracted_data: '{}', vendor_name: null, document_date: null, reference_number: null, total_amount: null,
  vat_amount: null, status: 'pending', matched_invoice_id: null, matched_bank_tx_id: null, notes: null,
  uploaded_by: USER, created_at: new Date().toISOString(), read_state: 'reading', read_error: null,
  read_heartbeat_at: null, ...over,
});

interface Call { text: string; values: unknown[] }
let calls: Call[];
let inFlight: number;

function respond() {
  const res = {
    statusCode: 0, sent: undefined as unknown,
    setHeader() { return this; },
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.sent = p; return this; },
  };
  return res;
}
async function post() {
  const req = { method: 'POST', query: {}, headers: {}, companyId: CO, user: { id: USER } } as unknown as NextApiRequest;
  const res = respond();
  await (handler as unknown as (a: NextApiRequest, b: unknown) => Promise<void>)(req, res);
  return res;
}
async function get(query: Record<string, string>) {
  const req = { method: 'GET', query, companyId: CO } as unknown as NextApiRequest;
  const res = respond();
  await (handler as unknown as (a: NextApiRequest, b: unknown) => Promise<void>)(req, res);
  return res;
}

beforeEach(() => {
  vi.resetAllMocks();
  calls = [];
  inFlight = 0;
  m.rateLimit.mockResolvedValue(true);
  m.uploadLimit.mockResolvedValue(true);
  m.parse.mockResolvedValue({ files: { file: file() } });
  m.bufferOf.mockReturnValue(PDF);
  m.store.mockResolvedValue({ documentId: DOC, bucket: 'captured-documents', path: `${CO}/${DOC}`, hash: 'h', size: PDF.length });
  m.sql.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').replace(/\s+/g, ' ');
    calls.push({ text, values });
    if (text.includes('COUNT(*)')) return [{ n: inFlight }];
    if (text.includes('INSERT INTO captured_documents')) return [insertedRow()];
    if (text.includes('UPDATE captured_documents')) return [insertedRow({ storage_bucket: 'captured-documents', storage_path: `${CO}/${DOC}` })];
    return [];
  });
});

describe('POST /api/accounting/document-capture', () => {
  it("inserts a 'reading' row with empty extraction, scoped to the company, and answers 201 { document } without `extracted`", async () => {
    const res = await post();
    expect(res.statusCode).toBe(201);
    const data = (res.sent as { data: Record<string, unknown> }).data;
    expect(Object.keys(data)).toEqual(['document']);
    expect(data.document).toMatchObject({ id: DOC, readState: 'reading', readError: null, documentType: null });
    const ins = calls.find((c) => c.text.includes('INSERT INTO captured_documents'))!;
    expect(ins.text).toContain("'{}'::jsonb");
    expect(ins.text).toContain("'reading'");
    expect(ins.values).toEqual(expect.arrayContaining([CO, 'inv.pdf', 'pdf', USER]));
  });

  it('queues the read after COMMIT with a label, and does not run it inline', async () => {
    await post();
    expect(m.runAfterCommit).toHaveBeenCalledTimes(1);
    expect(m.runAfterCommit.mock.calls[0]![0]).toBe('capture-read');
    expect(m.runCaptureRead).not.toHaveBeenCalled();
    await (m.runAfterCommit.mock.calls[0]![1] as () => Promise<void>)();
    expect(m.runCaptureRead).toHaveBeenCalledWith(CO, DOC, 0);
  });

  it('hands the job only ids and the attempt: the request closure no longer holds the buffer', async () => {
    await post();
    await (m.runAfterCommit.mock.calls[0]![1] as () => Promise<void>)();
    expect(m.runCaptureRead.mock.calls[0]).toEqual([CO, DOC, 0]);
  });

  it('charges the AI rate limit without a refund, and answers 429 when it is used up (nothing inserted)', async () => {
    m.rateLimit.mockResolvedValue(false);
    const res = await post();
    expect(res.statusCode).toBe(429);
    expect(m.rateLimit.mock.calls[0]![1]).toBe(CO);
    expect(m.rateLimit.mock.calls[0]![2]).toBe('document-capture');
    expect(m.rateLimit.mock.calls[0]![3]).toEqual({ companyMax: 30, dailyMax: 300 });
    expect(calls.some((c) => c.text.includes('INSERT'))).toBe(false);
    expect(m.runAfterCommit).not.toHaveBeenCalled();
  });

  it('answers 429 for a 6th read in flight, counting only this company and only non-stale reading rows', async () => {
    inFlight = 5;
    const res = await post();
    expect(res.statusCode).toBe(429);
    expect(JSON.stringify(res.sent)).toContain('Too many documents are being read');
    const count = calls.find((c) => c.text.includes('COUNT(*)'))!;
    expect(count.text).toContain('company_id = ?');
    expect(count.text).toContain("read_state = 'reading'");
    expect(count.text).toContain('COALESCE(read_heartbeat_at, created_at) >');
    expect(count.values).toEqual(expect.arrayContaining([CO, 5]));
    expect(calls.some((c) => c.text.includes('INSERT'))).toBe(false);
    expect(m.runAfterCommit).not.toHaveBeenCalled();
  });

  it('accepts the 5th read in flight', async () => {
    inFlight = 4;
    expect((await post()).statusCode).toBe(201);
  });

  it('does not charge the rate limit for a request that fails validation (no file, wrong type, wrong bytes)', async () => {
    m.parse.mockResolvedValue({ files: {} });
    expect((await post()).statusCode).toBe(400);
    m.parse.mockResolvedValue({ files: { file: file({ mimetype: 'text/plain' }) } });
    expect((await post()).statusCode).toBe(400);
    m.parse.mockResolvedValue({ files: { file: file() } });
    m.bufferOf.mockReturnValue(Buffer.from('PK\u0003\u0004 not a pdf'));
    expect((await post()).statusCode).toBe(400);
    m.bufferOf.mockReturnValue(Buffer.alloc(0));
    expect((await post()).statusCode).toBe(400);
    expect(m.rateLimit).not.toHaveBeenCalled();
  });

  it('bounds every request first, even one that ends in a 400: a per-company upload limiter before the form is parsed', async () => {
    const order: string[] = [];
    m.uploadLimit.mockImplementation(async () => { order.push('upload-limit'); return true; });
    m.parse.mockImplementation(async () => { order.push('parse'); return { files: {} }; });
    expect((await post()).statusCode).toBe(400);
    expect(order).toEqual(['upload-limit', 'parse']);
    expect(m.uploadLimit).toHaveBeenCalledWith(`upload:document-capture:co:${CO}`, { max: 60, windowSecs: 900 });
  });

  it('answers 429 when the upload limiter is used up: nothing parsed, no AI unit charged, nothing inserted', async () => {
    m.uploadLimit.mockResolvedValue(false);
    const res = await post();
    expect(res.statusCode).toBe(429);
    expect(JSON.stringify(res.sent)).toContain('Too many uploads — wait a few minutes and try again.');
    expect(JSON.stringify(res.sent)).not.toContain('AI request limit');
    expect(m.parse).not.toHaveBeenCalled();
    expect(m.rateLimit).not.toHaveBeenCalled();
    expect(calls.some((c) => c.text.includes('INSERT'))).toBe(false);
  });

  it('charges the AI unit only after validation AND the in-flight check, so a cap 429 burns no unit', async () => {
    inFlight = 5;
    expect((await post()).statusCode).toBe(429);
    expect(m.rateLimit).not.toHaveBeenCalled();
  });

  it('charges it once a valid file has been parsed and there is room, just before the insert', async () => {
    const order: string[] = [];
    m.rateLimit.mockImplementation(async () => { order.push('rate'); return true; });
    m.sql.mockImplementation(async (strings: TemplateStringsArray) => {
      const text = strings.join('?');
      order.push(text.includes('COUNT(*)') ? 'count' : text.includes('INSERT') ? 'insert' : 'other');
      return text.includes('COUNT(*)') ? [{ n: 0 }] : [insertedRow()];
    });
    await post();
    expect(order.slice(0, 3)).toEqual(['count', 'rate', 'insert']);
  });

  it('records the hash and size on the insert, as /capture/upload does', async () => {
    await post();
    const ins = calls.find((c) => c.text.includes('INSERT INTO captured_documents'))!;
    expect(ins.text).toContain('raw_bytes_sha256');
    expect(ins.text).toContain('raw_bytes_size');
    expect(ins.values).toEqual(expect.arrayContaining([sha256(PDF), PDF.length]));
  });

  it('stores the bytes under the new id and the declared mime, then writes the pointer scoped to the company', async () => {
    await post();
    expect(m.store).toHaveBeenCalledTimes(1);
    expect(m.store).toHaveBeenCalledWith(CO, DOC, PDF, 'application/pdf');
    const upd = calls.find((c) => c.text.includes('UPDATE captured_documents'))!;
    expect(upd.text).toContain('storage_bucket');
    expect(upd.text).toContain('storage_path');
    expect(upd.text).toMatch(/WHERE id = \? ?::uuid AND company_id = \?|WHERE id = \?::uuid AND company_id = \?/);
    expect(upd.values).toEqual(expect.arrayContaining(['captured-documents', `${CO}/${DOC}`, DOC, CO]));
  });

  it('does everything before answering, in order: insert, store, pointer, then queue', async () => {
    const order: string[] = [];
    m.store.mockImplementation(async () => { order.push('store'); return { documentId: DOC, bucket: 'b', path: 'p', hash: 'h', size: 1 }; });
    m.runAfterCommit.mockImplementation(() => { order.push('queue'); });
    m.sql.mockImplementation(async (strings: TemplateStringsArray) => {
      const t = strings.join('?');
      if (t.includes('COUNT(*)')) return [{ n: 0 }];
      if (t.includes('INSERT INTO captured_documents')) { order.push('insert'); return [insertedRow()]; }
      if (t.includes('UPDATE captured_documents')) { order.push('pointer'); return [insertedRow({ storage_path: 'p' })]; }
      return [];
    });
    expect((await post()).statusCode).toBe(201);
    expect(order).toEqual(['insert', 'store', 'pointer', 'queue']);
  });

  it('a Storage failure fails the request with 500 and queues nothing (the withAuth transaction rolls the insert back)', async () => {
    m.store.mockRejectedValue(new Error('storage down'));
    const res = await post();
    expect(res.statusCode).toBe(500);
    expect(m.runAfterCommit).not.toHaveBeenCalled();
    expect(calls.some((c) => c.text.includes('UPDATE captured_documents'))).toBe(false);
  });

  it('a failure writing the pointer queues nothing either', async () => {
    m.sql.mockImplementation(async (strings: TemplateStringsArray) => {
      const t = strings.join('?');
      if (t.includes('COUNT(*)')) return [{ n: 0 }];
      if (t.includes('INSERT INTO captured_documents')) return [insertedRow()];
      throw new Error('pointer write failed');
    });
    expect((await post()).statusCode).toBe(500);
    expect(m.runAfterCommit).not.toHaveBeenCalled();
  });

  it('stores nothing for a request that fails validation or a limit', async () => {
    m.parse.mockResolvedValue({ files: {} });
    await post();
    m.parse.mockResolvedValue({ files: { file: file() } });
    inFlight = 5;
    await post();
    m.rateLimit.mockResolvedValue(false);
    inFlight = 0;
    await post();
    expect(m.store).not.toHaveBeenCalled();
  });

  it('the response carries retryable, false while it is being read, and never the storage pointer', async () => {
    const res = await post();
    const doc = (res.sent as { data: { document: Record<string, unknown> } }).data.document;
    expect(doc.retryable).toBe(false);
    expect(JSON.stringify(res.sent)).not.toContain('storage_path');
    expect(JSON.stringify(res.sent)).not.toContain(`${CO}/${DOC}`);
  });

  it('still validates before it inserts: a file whose bytes do not match its type is a 400', async () => {
    m.bufferOf.mockReturnValue(Buffer.from('PK\u0003\u0004 not a pdf'));
    const res = await post();
    expect(res.statusCode).toBe(400);
    expect(calls.some((c) => c.text.includes('INSERT'))).toBe(false);
  });

  it('answers 400 with no file, and for an unsupported type', async () => {
    m.parse.mockResolvedValue({ files: {} });
    expect((await post()).statusCode).toBe(400);
    m.parse.mockResolvedValue({ files: { file: file({ mimetype: 'text/plain' }) } });
    expect((await post()).statusCode).toBe(400);
  });

  it('does not return the file contents or any extraction in the response', async () => {
    const res = await post();
    expect(JSON.stringify(res.sent)).not.toContain('%PDF');
  });
});

describe('GET /api/accounting/document-capture — read state', () => {
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

  it('maps a fresh reading row to readState reading', async () => {
    m.sql.mockResolvedValue([insertedRow({ created_at: minutesAgo(1) })]);
    const res = await get({ id: DOC });
    expect((res.sent as { data: Record<string, unknown> }).data).toMatchObject({ readState: 'reading', readError: null });
  });

  it('reports a reading row silent for over 5 minutes as failed with the upload-again message', async () => {
    m.sql.mockResolvedValue([insertedRow({ created_at: minutesAgo(30), read_heartbeat_at: minutesAgo(6) })]);
    const res = await get({ id: DOC });
    expect((res.sent as { data: Record<string, unknown> }).data).toMatchObject({
      readState: 'failed', readError: 'The read was interrupted — upload the document again.',
    });
  });

  it('says retry only for a stale row that can be retried (stored file, pending, unposted)', async () => {
    m.sql.mockResolvedValue([insertedRow({ created_at: minutesAgo(30), storage_path: 'co/doc', posted_at: null })]);
    const res = await get({ id: DOC });
    expect((res.sent as { data: Record<string, unknown> }).data).toMatchObject({
      readState: 'failed', readError: 'The read was interrupted — retry it.', retryable: true,
    });
  });

  it('maps every row of the list', async () => {
    m.sql.mockImplementation(async (strings: TemplateStringsArray) => (strings.join('?').includes('COUNT')
      ? [{ total: 2 }]
      : [insertedRow(), insertedRow({ id: 'x', read_state: 'done' }), ]));
    const res = await get({});
    const list = (res.sent as { data: Array<{ readState: string }> }).data;
    expect(list.map((d) => d.readState)).toEqual(['reading', 'done']);
  });
});
