/**
 * The background job that reads an uploaded capture document (from Storage, by the attempt it was started for). It runs after the request committed, outside any
 * transaction and as the pool role with no row-level security, so EVERY statement it issues must name the company,
 * and every write is guarded by `read_state = 'reading'`: a row that was rejected or posted meanwhile keeps its
 * user data, and only stops showing "reading".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';

const m = vi.hoisted(() => ({
  sql: vi.fn(),
  read: vi.fn(),
  fetch: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/lib/neon', () => ({ sql: m.sql }));
vi.mock('@/lib/logger', () => ({ log: { info: m.info, warn: m.warn, error: m.error, debug: vi.fn() } }));
vi.mock('@/lib/documentStorage', async (orig) => ({ ...(await orig<typeof import('@/lib/documentStorage')>()), fetchRawBytes: m.fetch }));
vi.mock('@/modules/accounting/services/capture/captureUploadForm', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/capture/captureUploadForm')>()),
  readUploadedDocument: m.read,
}));

import { sha256 } from '@/lib/documentStorage';
import { runCaptureRead } from '@/modules/accounting/services/capture/captureReadJob';
import { GENERIC_READ_ERROR, NOT_STORED_ERROR, STALE_READ_ERROR, STALE_AFTER_MINUTES } from '@/modules/accounting/services/capture/captureReadState';

const CO = 'aaaaaaaa-0000-0000-0000-000000000001';
const DOC = 'cccccccc-0000-0000-0000-000000000003';
const BUF = Buffer.from('%PDF-1.4 test');
const ATTEMPT = 3;
const stored = (fileType = 'pdf', storedHash: string | null = sha256(BUF)) => ({ buffer: BUF, hash: storedHash ?? 'fabricated', storedHash, size: BUF.length, fileType });

interface Call { text: string; values: unknown[] }
const calls: Call[] = [];
const squash = (t: string) => t.replace(/::\w+/g, '').replace(/\s+/g, ' ').trim();
const text = (c: Call) => squash(c.text);
const callsOn = (needle: string) => calls.filter((c) => text(c).includes(needle));

/** What the database says to each guarded statement: the rows its RETURNING gives. */
let db: { saved: unknown[]; fallback: unknown[]; failed: unknown[] };

const extracted = (over: Partial<ExtractedDocument> = {}): ExtractedDocument => ({
  documentType: 'invoice', vendorName: 'Acme', vendorVatNumber: null, vendorAddress: null, vendorBankDetails: null,
  customerName: null, customerVatNumber: null, date: '2026-10-01', dueDate: null, paymentTerms: null,
  referenceNumber: 'INV-1', purchaseOrderRef: null, currency: 'ZAR', subtotal: 100, vatAmount: 15, vatRate: 15,
  totalAmount: 115, lineItems: [], rawText: 'raw', confidence: 0.9, warnings: [], extractionMethod: 'vlm', ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  calls.length = 0;
  db = { saved: [{ id: DOC }], fallback: [{ id: DOC, read_state: 'done' }], failed: [{ id: DOC }] };
  m.sql.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const c = { text: strings.join('?'), values };
    calls.push(c);
    const t = text(c);
    if (t.includes("read_state = 'failed'")) return db.failed;
    if (t.includes('extracted_data =')) return db.saved;
    if (t.includes('SET read_state = CASE')) return db.fallback;
    return [];
  });
  m.read.mockResolvedValue(extracted());
  m.fetch.mockResolvedValue(stored());
});

afterEach(() => { vi.useRealTimers(); });

describe('runCaptureRead — save', () => {
  it('loads the bytes from Storage by document and company, and reads them with the mime type of the stored file type', async () => {
    await runCaptureRead(CO, DOC, ATTEMPT);
    expect(m.fetch).toHaveBeenCalledWith(DOC, CO);
    expect(m.read).toHaveBeenCalledWith(BUF, 'application/pdf');
  });

  it.each([['jpeg', 'image/jpeg'], ['png', 'image/png'], ['webp', 'image/webp'], ['tiff', 'image/tiff']])(
    'a stored %s is read as %s', async (fileType, mime) => {
      m.fetch.mockResolvedValue(stored(fileType));
      await runCaptureRead(CO, DOC, ATTEMPT);
      expect(m.read).toHaveBeenCalledWith(BUF, mime);
    });

  it('fills the extracted columns and finishes the row in ONE guarded UPDATE', async () => {
    await runCaptureRead(CO, DOC, ATTEMPT);
    const [save] = callsOn('extracted_data =');
    expect(save).toBeDefined();
    const t = text(save!);
    expect(t).toContain("read_state = 'done'");
    expect(t).toContain('read_error = NULL');
    expect(t).toContain('read_heartbeat_at = NOW()');
    expect(t).toContain("WHERE id = ? AND company_id = ? AND read_state = 'reading' AND read_attempt = ? AND posted_at IS NULL AND status = 'pending'");
    expect(t).toContain('AND COALESCE(read_heartbeat_at, created_at) > NOW() - make_interval(mins => ?)');
    expect(save!.values).toContain(STALE_AFTER_MINUTES);
    expect(save!.values).toContain(DOC);
    expect(save!.values).toContain(CO);
    const json = save!.values.find((v) => typeof v === 'string' && v.startsWith('{')) as string;
    expect(JSON.parse(json)).toMatchObject({ vendorName: 'Acme', totalAmount: 115 });
    expect(save!.values).toEqual(expect.arrayContaining(['invoice', 'Acme', '2026-10-01', 'INV-1', 115, 15]));
  });

  it('lets a value a person typed win: every scalar column is COALESCE(column, read value)', async () => {
    await runCaptureRead(CO, DOC, ATTEMPT);
    const t = text(callsOn('extracted_data =')[0]!);
    for (const col of ['document_type', 'vendor_name', 'document_date', 'reference_number', 'total_amount', 'vat_amount']) {
      expect(t).toMatch(new RegExp(`${col} = COALESCE\\(${col}, \\?\\)`));
    }
  });

  it('writes no null date when the read found none', async () => {
    m.read.mockResolvedValue(extracted({ date: null }));
    await runCaptureRead(CO, DOC, ATTEMPT);
    expect(callsOn('extracted_data =')[0]!.values).toContain(null);
  });

  it('logs the save by outcome', async () => {
    await runCaptureRead(CO, DOC, ATTEMPT);
    expect(m.info.mock.calls.map((c) => String(c[0])).join('|')).toContain('read complete');
    expect(callsOn('SET read_state = CASE')).toHaveLength(0);
  });
});

describe('runCaptureRead — a row the user settled, or that went stale, meanwhile', () => {
  beforeEach(() => { db.saved = []; });

  it('does not write user data: one guarded UPDATE moves only read_state/read_error, naming no data column', async () => {
    await runCaptureRead(CO, DOC, ATTEMPT);
    const [fb] = callsOn('SET read_state = CASE');
    expect(fb).toBeDefined();
    const t = text(fb!);
    expect(t).toContain("WHERE id = ? AND company_id = ? AND read_state = 'reading' AND read_attempt = ?");
    for (const col of ['extracted_data', 'vendor_name', 'total_amount', 'status', 'document_type', 'notes', 'posted_at']) {
      expect(t).not.toContain(`${col} =`);
    }
    expect(fb!.values).toEqual(expect.arrayContaining([DOC, CO]));
    expect(fb!.values.some((v) => typeof v === 'string' && v.startsWith('{'))).toBe(false);
  });

  it('a stale row ends failed with the interrupted message; a fresh settled one ends done (decided in the statement)', async () => {
    await runCaptureRead(CO, DOC, ATTEMPT);
    const t = text(callsOn('SET read_state = CASE')[0]!);
    expect(t).toContain("WHEN COALESCE(read_heartbeat_at, created_at) > NOW() - make_interval(mins => ?) THEN 'done' ELSE 'failed'");
    expect(t).toContain('THEN NULL ELSE ? END');
    expect(callsOn('SET read_state = CASE')[0]!.values).toEqual(expect.arrayContaining([STALE_AFTER_MINUTES, STALE_READ_ERROR]));
  });

  it('reports a settled row and a stale row differently, and never as complete', async () => {
    await runCaptureRead(CO, DOC, ATTEMPT);
    expect(m.warn).toHaveBeenCalledWith(expect.stringContaining('settled meanwhile'), expect.anything(), expect.anything());
    m.warn.mockClear();
    db.fallback = [{ id: DOC, read_state: 'failed' }];
    await runCaptureRead(CO, DOC, ATTEMPT);
    expect(m.warn).toHaveBeenCalledWith(expect.stringContaining('went stale'), expect.anything(), expect.anything());
    expect(m.info.mock.calls.map((c) => String(c[0])).join('|')).not.toContain('read complete');
  });

  it('logs when even the fallback matched nothing (the row is gone)', async () => {
    db.fallback = [];
    await runCaptureRead(CO, DOC, ATTEMPT);
    expect(m.warn.mock.calls.map((c) => String(c[0])).join('|')).toContain('no longer reading');
  });
});

describe('runCaptureRead — the date the read found', () => {
  const dateSent = () => {
    const [save] = callsOn('extracted_data =');
    // values: json, documentType, vendorName, date, referenceNumber, totalAmount, vatAmount, ...
    return save!.values[3];
  };

  it.each(['2026-13-45', '2026-02-30', 'not a date', '01/10/2026', '', '2026-10-01T10:00:00Z'])(
    '%j becomes NULL instead of failing the whole read', async (bad) => {
      m.read.mockResolvedValue(extracted({ date: bad }));
      await runCaptureRead(CO, DOC, ATTEMPT);
      expect(dateSent()).toBeNull();
      expect(callsOn("read_state = 'failed'")).toHaveLength(0);
    });

  it('keeps a valid date, including a leap day', async () => {
    m.read.mockResolvedValue(extracted({ date: '2028-02-29' }));
    await runCaptureRead(CO, DOC, ATTEMPT);
    expect(dateSent()).toBe('2028-02-29');
  });

  it('keeps the invalid date in extracted_data, where a person can see what the read said', async () => {
    m.read.mockResolvedValue(extracted({ date: '2026-13-45' }));
    await runCaptureRead(CO, DOC, ATTEMPT);
    const json = callsOn('extracted_data =')[0]!.values[0] as string;
    expect(JSON.parse(json).date).toBe('2026-13-45');
  });
});

describe('runCaptureRead — failure', () => {
  it('marks the row failed with a generic message, guarded by reading, and logs the real error', async () => {
    m.read.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8100'));
    await runCaptureRead(CO, DOC, ATTEMPT);
    const [failed] = callsOn("read_state = 'failed'");
    expect(failed).toBeDefined();
    expect(text(failed!)).toContain("WHERE id = ? AND company_id = ? AND read_state = 'reading' AND read_attempt = ?");
    expect(failed!.values).toContain(GENERIC_READ_ERROR);
    expect(failed!.values.join('|')).not.toContain('ECONNREFUSED');
    expect(callsOn('extracted_data =')).toHaveLength(0);
    expect(JSON.stringify(m.error.mock.calls)).toContain('ECONNREFUSED');
  });

  it('never throws, even when recording the failure fails too', async () => {
    m.read.mockRejectedValue(new Error('vlm down'));
    m.sql.mockRejectedValue(new Error('db down'));
    await expect(runCaptureRead(CO, DOC, ATTEMPT)).resolves.toBeUndefined();
    expect(m.error.mock.calls.map((c) => String(c[0])).join('|')).toContain('could not record');
  });

  it('never throws when the save itself fails', async () => {
    m.sql.mockImplementation(async (strings: TemplateStringsArray) => {
      if (strings.join('?').includes('extracted_data =')) throw new Error('invalid input syntax for type date');
      return [{ id: DOC }];
    });
    await expect(runCaptureRead(CO, DOC, ATTEMPT)).resolves.toBeUndefined();
    expect(m.sql.mock.calls.some((c) => (c[0] as TemplateStringsArray).join('?').includes("read_state = 'failed'"))).toBe(true);
  });
});

describe('runCaptureRead — heartbeat and scoping', () => {
  it('touches the heartbeat while the read waits, only on a row still reading', async () => {
    vi.useFakeTimers();
    let release: (d: ExtractedDocument) => void = () => undefined;
    m.read.mockImplementation(() => new Promise<ExtractedDocument>((resolve) => { release = resolve; }));
    const done = runCaptureRead(CO, DOC, ATTEMPT);
    await vi.advanceTimersByTimeAsync(130_000);
    const beats = callsOn('SET read_heartbeat_at = NOW()');
    expect(beats.length).toBeGreaterThanOrEqual(2);
    expect(text(beats[0]!)).toContain("WHERE id = ? AND company_id = ? AND read_state = 'reading' AND read_attempt = ?");
    release(extracted());
    await done;
    const after = calls.length;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(calls.length).toBe(after);
  });

  it('logs a failed heartbeat under the capture read label, not the statement one', async () => {
    vi.useFakeTimers();
    m.sql.mockImplementation(async (strings: TemplateStringsArray) => {
      if (strings.join('?').includes('SET read_heartbeat_at = NOW()')) throw new Error('db blip');
      return [{ id: DOC, read_state: 'done' }];
    });
    let release: (d: ExtractedDocument) => void = () => undefined;
    m.read.mockImplementation(() => new Promise<ExtractedDocument>((resolve) => { release = resolve; }));
    const done = runCaptureRead(CO, DOC, ATTEMPT);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(m.warn).toHaveBeenCalledWith('Capture read keep-alive heartbeat failed', expect.anything(), 'capture-read');
    release(extracted());
    await done;
  });

  it('stops beating at the 15-minute ceiling for a read that never settles', async () => {
    vi.useFakeTimers();
    m.read.mockImplementation(() => new Promise<ExtractedDocument>(() => undefined));
    void runCaptureRead(CO, DOC, ATTEMPT);
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1000);
    const atCeiling = callsOn('SET read_heartbeat_at = NOW()').length;
    expect(atCeiling).toBeGreaterThan(10);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(callsOn('SET read_heartbeat_at = NOW()').length).toBe(atCeiling);
  });

  it('names the company in every statement it issues', async () => {
    const run = async () => { calls.length = 0; await runCaptureRead(CO, DOC, ATTEMPT); };
    await run();
    m.read.mockRejectedValue(new Error('x'));
    const ok = [...calls];
    await run();
    for (const c of [...ok, ...calls]) {
      expect(text(c)).toContain('company_id = ?');
      expect(c.values).toContain(CO);
    }
  });
});

describe('runCaptureRead — the attempt fence', () => {
  const ATTEMPT_RE = /read_attempt = \?/;

  it('every statement it issues is fenced on read_attempt = the attempt it was started for', async () => {
    const all: Call[] = [];
    const record = async (run: () => Promise<void>) => { calls.length = 0; await run(); all.push(...calls); };
    await record(() => runCaptureRead(CO, DOC, ATTEMPT));                                    // save
    db.saved = [];
    await record(() => runCaptureRead(CO, DOC, ATTEMPT));                                    // fallback
    m.read.mockRejectedValue(new Error('x'));
    await record(() => runCaptureRead(CO, DOC, ATTEMPT));                                    // failure
    m.fetch.mockResolvedValue(null);
    await record(() => runCaptureRead(CO, DOC, ATTEMPT));                                    // not stored
    expect(all.length).toBeGreaterThanOrEqual(4);
    for (const c of all) {
      expect(text(c)).toMatch(ATTEMPT_RE);
      expect(c.values).toContain(ATTEMPT);
    }
  });

  it('the heartbeat is fenced too, so a job thought dead cannot keep its replacement looking alive', async () => {
    vi.useFakeTimers();
    let release: (d: ExtractedDocument) => void = () => undefined;
    m.read.mockImplementation(() => new Promise<ExtractedDocument>((resolve) => { release = resolve; }));
    const done = runCaptureRead(CO, DOC, ATTEMPT);
    await vi.advanceTimersByTimeAsync(61_000);
    const beats = callsOn('SET read_heartbeat_at = NOW()');
    expect(beats.length).toBeGreaterThan(0);
    for (const b of beats) expect(text(b)).toMatch(ATTEMPT_RE);
    release(extracted());
    await done;
  });

  it('the save binds the attempt right after the company, before the stale window', async () => {
    await runCaptureRead(CO, DOC, ATTEMPT);
    const { values } = callsOn('extracted_data =')[0]!;
    const at = values.indexOf(CO);
    expect(values.slice(at, at + 3)).toEqual([CO, ATTEMPT, STALE_AFTER_MINUTES]);
  });

  it('every file_type key an upload saves has a mime type to be read as', async () => {
    const form = await import('@/modules/accounting/services/capture/captureUploadForm');
    for (const key of new Set(Object.values(form.ALLOWED_MIME_TYPES))) {
      expect(form.MIME_BY_FILE_TYPE[key]).toBeDefined();
      expect(form.ALLOWED_MIME_TYPES[form.MIME_BY_FILE_TYPE[key]!]).toBe(key);
    }
  });
});

describe('runCaptureRead — the file is not in Storage', () => {
  it('a row with no stored bytes fails with the not-stored message, and nothing is read', async () => {
    m.fetch.mockResolvedValue(null);
    await runCaptureRead(CO, DOC, ATTEMPT);
    const [failed] = callsOn("read_state = 'failed'");
    expect(failed).toBeDefined();
    expect(failed!.values).toContain(NOT_STORED_ERROR);
    expect(m.read).not.toHaveBeenCalled();
    expect(callsOn('extracted_data =')).toHaveLength(0);
  });

  it('an object the bucket no longer has fails the same way (not retryable)', async () => {
    const { CapturedDocumentMissingError } = await import('@/lib/supabaseStorage');
    m.fetch.mockRejectedValue(new CapturedDocumentMissingError('co/doc', 'Object not found'));
    await runCaptureRead(CO, DOC, ATTEMPT);
    expect(callsOn("read_state = 'failed'")[0]!.values).toContain(NOT_STORED_ERROR);
    expect(m.read).not.toHaveBeenCalled();
  });

  it('any other Storage failure (an outage) fails with the generic message, so it stays retryable', async () => {
    m.fetch.mockRejectedValue(new Error('Storage download failed: fetch failed'));
    await runCaptureRead(CO, DOC, ATTEMPT);
    const values = callsOn("read_state = 'failed'")[0]!.values;
    expect(values).toContain(GENERIC_READ_ERROR);
    expect(values).not.toContain(NOT_STORED_ERROR);
  });

  it('never throws on a Storage failure', async () => {
    m.fetch.mockRejectedValue(new Error('boom'));
    await expect(runCaptureRead(CO, DOC, ATTEMPT)).resolves.toBeUndefined();
  });
});

describe('runCaptureRead — integrity of the stored file', () => {
  it('reads bytes whose hash matches the recorded one', async () => {
    await runCaptureRead(CO, DOC, ATTEMPT);
    expect(m.read).toHaveBeenCalledTimes(1);
  });

  it('a row with no recorded hash (legacy) is read without the check: the fabricated hash is never compared', async () => {
    m.fetch.mockResolvedValue(stored('pdf', null));
    await runCaptureRead(CO, DOC, ATTEMPT);
    expect(m.read).toHaveBeenCalledTimes(1);
    expect(callsOn("read_state = 'failed'")).toHaveLength(0);
  });

  it('bytes that do not match the recorded hash fail the read as not stored (not retryable), and are never read', async () => {
    m.fetch.mockResolvedValue(stored('pdf', sha256(Buffer.from('some other file'))));
    await runCaptureRead(CO, DOC, ATTEMPT);
    const [failed] = callsOn("read_state = 'failed'");
    expect(failed).toBeDefined();
    expect(failed!.values).toContain(NOT_STORED_ERROR);
    expect(m.read).not.toHaveBeenCalled();
    expect(callsOn('extracted_data =')).toHaveLength(0);
  });

  it('logs the mismatch, and the hashes appear in neither the log nor the message the row carries', async () => {
    const recorded = sha256(Buffer.from('some other file'));
    m.fetch.mockResolvedValue(stored('pdf', recorded));
    await runCaptureRead(CO, DOC, ATTEMPT);
    expect(m.error.mock.calls.map((c) => String(c[0])).join('|')).toContain('integrity');
    expect(JSON.stringify(m.error.mock.calls)).not.toContain(recorded);
    expect(JSON.stringify(m.error.mock.calls)).not.toContain(sha256(BUF));
    expect(JSON.stringify(callsOn("read_state = 'failed'")[0]!.values)).not.toContain(recorded);
  });
});
