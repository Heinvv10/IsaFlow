/**
 * The posting claim refuses a document whose upload is still being read ('being_read'), before any write, and every
 * caller answers it as a conflict with the same wording. A stale read (shown as interrupted) or a finished one is
 * claimable as before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiResponse } from 'next';

const m = vi.hoisted(() => ({ sql: vi.fn(), lock: vi.fn(), findPosted: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: m.sql }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/capture/postedContentFence', async (orig) => ({
  ...(await orig<object>()), lockPostedContent: m.lock, findPostedContent: m.findPosted,
}));

import {
  CAPTURED_DOCUMENT_REFUSAL_MESSAGE, CapturedDocumentAlreadyPostedError, claimCapturedDocumentForPosting,
  respondCapturedDocumentRefusal,
} from '@/modules/accounting/services/capture/capturePostingClaim';
import { NOT_READ, STILL_BEING_READ } from '@/modules/accounting/services/capture/captureReadState';

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
let doc: Record<string, unknown>;
let updateRows: unknown[];
const texts: string[] = [];

beforeEach(() => {
  vi.resetAllMocks();
  texts.length = 0;
  updateRows = [{ id: 'd' }];
  doc = { raw_bytes_sha256: null, status: 'pending', posted_at: null, read_state: 'reading', read_heartbeat_at: null, created_at: minutesAgo(1) };
  m.findPosted.mockResolvedValue(null);
  m.sql.mockImplementation(async (strings: TemplateStringsArray) => {
    const t = strings.join('?').replace(/\s+/g, ' ').trim();
    texts.push(t);
    if (t.startsWith('UPDATE captured_documents')) return updateRows;
    return [doc];
  });
});

const claim = () => claimCapturedDocumentForPosting('c', 'd', null, { spend: 'invoice' });
const wrote = () => texts.some((t) => t.startsWith('UPDATE'));

describe('claimCapturedDocumentForPosting and a document being read', () => {
  it("refuses a fresh 'reading' row as being_read, before taking any lock or writing", async () => {
    expect(await claim()).toBe('being_read');
    expect(wrote()).toBe(false);
    expect(m.lock).not.toHaveBeenCalled();
  });

  it("refuses a row whose read failed, or went silent (shown as interrupted), as not_read — nothing to post", async () => {
    doc = { ...doc, created_at: minutesAgo(30) };
    expect(await claim()).toBe('not_read');
    doc = { ...doc, read_state: 'failed', created_at: minutesAgo(1) };
    expect(await claim()).toBe('not_read');
    expect(wrote()).toBe(false);
    expect(m.lock).not.toHaveBeenCalled();
  });

  it('claims a row whose read finished', async () => {
    doc = { ...doc, read_state: 'done', created_at: minutesAgo(1) };
    expect(await claim()).toBeNull();
  });

  it('claims a row from a caller that carries no read columns', async () => {
    doc = { raw_bytes_sha256: null };
    expect(await claim()).toBeNull();
  });

  it("the claiming UPDATE carries the fence itself (read_state = 'done'), and a refusal it causes reads back as the gate's", async () => {
    // the pre-check sees a finished read; the statement then refuses (the row went back to reading between the two
    // — impossible today, but the fence must not depend on it) and the re-read says why
    const rows = [{ ...doc, read_state: 'done' }, { ...doc, created_at: minutesAgo(1) }];
    let reads = 0;
    m.sql.mockImplementation(async (strings: TemplateStringsArray) => {
      const t = strings.join('?').replace(/\s+/g, ' ').trim();
      texts.push(t);
      if (t.startsWith('UPDATE captured_documents')) return [];
      return [rows[Math.min(reads++, 1)]];
    });
    expect(await claim()).toBe('being_read');
    const update = texts.find((t) => t.startsWith('UPDATE'))!;
    expect(update).toContain("AND read_state = 'done'");
  });

  it("the re-read reports a failed row as not_read", async () => {
    const rows = [{ ...doc, read_state: 'done' }, { ...doc, read_state: 'failed' }];
    let reads = 0;
    m.sql.mockImplementation(async (strings: TemplateStringsArray) => {
      const t = strings.join('?').replace(/\s+/g, ' ').trim();
      if (t.startsWith('UPDATE captured_documents')) return [];
      return [rows[Math.min(reads++, 1)]];
    });
    expect(await claim()).toBe('not_read');
  });
});

describe('answering being_read', () => {
  it('has the shared wording and a thrown form callers can answer', () => {
    expect(CAPTURED_DOCUMENT_REFUSAL_MESSAGE.being_read).toBe(STILL_BEING_READ);
    expect(new CapturedDocumentAlreadyPostedError('being_read').message).toBe(STILL_BEING_READ);
    expect(CAPTURED_DOCUMENT_REFUSAL_MESSAGE.not_read).toBe(NOT_READ);
    expect(new CapturedDocumentAlreadyPostedError('not_read').message).toBe(NOT_READ);
  });

  it('is a 409 conflict through respondCapturedDocumentRefusal (post, post-expense, receipt-to-journal, ai-invoice-pipeline)', () => {
    const res = { statusCode: 0, sent: undefined as unknown, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.sent = p; return this; }, setHeader() { return this; } };
    respondCapturedDocumentRefusal(res as unknown as NextApiResponse, 'being_read');
    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.sent)).toContain(STILL_BEING_READ);
    respondCapturedDocumentRefusal(res as unknown as NextApiResponse, 'not_read');
    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.sent)).toContain(NOT_READ);
  });
});
