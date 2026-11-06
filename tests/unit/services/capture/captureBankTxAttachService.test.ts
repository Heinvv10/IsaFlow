import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/documentStorage', () => ({ fetchRawBytes: vi.fn() }));

import { attachCapturedDocToBankTx } from '@/modules/accounting/services/capture/captureBankTxAttachService';
import { fetchRawBytes } from '@/lib/documentStorage';

const COMPANY = '11111111-1111-1111-1111-111111111111';
const DOC = '22222222-2222-2222-2222-222222222222';
const TX = '33333333-3333-3333-3333-333333333333';

function mockSqlByQuery(handlers: Array<[needle: string, rows: unknown[]]>) {
  sqlMock.mockImplementation(async (strings: readonly string[]) => {
    const q = strings.join('?');
    for (const [needle, rows] of handlers) {
      if (q.includes(needle)) return rows;
    }
    return [];
  });
}

const happyHandlers = (over: Partial<Record<string, unknown[]>> = {}): Array<[string, unknown[]]> => [
  ['FROM captured_documents', over.doc ?? [{ id: DOC, file_name: 'slip.jpg', file_type: 'jpeg' }]],
  ['FROM bank_transactions', over.tx ?? [{ id: TX }]],
  ['SELECT id FROM bank_transaction_attachments', over.dup ?? []],
  ['UPDATE captured_documents', [{ id: DOC }]],
  ['INSERT INTO bank_transaction_attachments', []],
];

describe('attachCapturedDocToBankTx', () => {
  beforeEach(() => vi.clearAllMocks());

  it('links the document and mirrors the file into bank_transaction_attachments', async () => {
    mockSqlByQuery(happyHandlers());
    vi.mocked(fetchRawBytes).mockResolvedValue({
      buffer: Buffer.from('img-bytes'), hash: 'h', size: 9, fileType: 'jpeg',
    });
    const result = await attachCapturedDocToBankTx(COMPANY, DOC, TX, 'user-1');
    expect(result).toEqual({ ok: true, mirrored: true });
    const calls = sqlMock.mock.calls.map((c) => (c[0] as readonly string[]).join('?'));
    expect(calls.some((q) => q.includes('UPDATE captured_documents'))).toBe(true);
    expect(calls.some((q) => q.includes('INSERT INTO bank_transaction_attachments'))).toBe(true);
    expect(calls.find((q) => q.includes('FROM captured_documents'))).toContain('company_id');
    expect(calls.find((q) => q.includes('FROM bank_transactions'))).toContain('company_id');
    expect(calls.find((q) => q.includes('UPDATE captured_documents'))).toContain('company_id');
    const allValues = sqlMock.mock.calls.flatMap((c) => c.slice(1));
    expect(allValues).toContain(COMPANY);
  });

  // The email mirror stores a full MIME type where other writers store a short name. Either must store a data URL the
  // viewer can show, never application/octet-stream.
  const PDF_BYTES = Buffer.from('%PDF-1.7\n');
  const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
  const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const WEBP_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
  it.each([
    ['application/pdf', PDF_BYTES, 'data:application/pdf;base64,'], ['pdf', PDF_BYTES, 'data:application/pdf;base64,'],
    ['image/jpeg', JPEG_BYTES, 'data:image/jpeg;base64,'], ['IMAGE/JPG', JPEG_BYTES, 'data:image/jpeg;base64,'], ['jpg', JPEG_BYTES, 'data:image/jpeg;base64,'],
    ['image/png', PNG_BYTES, 'data:image/png;base64,'], ['image/webp', WEBP_BYTES, 'data:image/webp;base64,'],
    ['application/x-unknown', PDF_BYTES, 'data:application/octet-stream;base64,'],
    // An email can claim any type: a label the bytes contradict is not stored.
    ['application/pdf', Buffer.from('<html><script>alert(1)</script>'), 'data:application/octet-stream;base64,'],
    ['image/png', PDF_BYTES, 'data:application/octet-stream;base64,'],
  ])('stores file_type %s with these bytes as %s', async (fileType, buffer, prefix) => {
    mockSqlByQuery(happyHandlers({ doc: [{ id: DOC, file_name: 'slip', file_type: fileType }] }));
    vi.mocked(fetchRawBytes).mockResolvedValue({ buffer, hash: 'h', size: buffer.length, fileType });
    await attachCapturedDocToBankTx(COMPANY, DOC, TX, 'user-1');
    const insert = sqlMock.mock.calls.find((c) => (c[0] as readonly string[]).join('?').includes('INSERT INTO bank_transaction_attachments'))!;
    expect(insert.slice(1).find((v) => typeof v === 'string' && v.startsWith('data:'))).toBe(`${prefix}${buffer.toString('base64')}`);
  });

  it('names the copy from the stored id, never the request\'s spelling of it', async () => {
    mockSqlByQuery(happyHandlers({ doc: [{ id: DOC, file_name: 'slip.jpg', file_type: 'jpeg' }] }));
    vi.mocked(fetchRawBytes).mockResolvedValue({ buffer: Buffer.from('img'), hash: 'h', size: 3, fileType: 'jpeg' });
    await attachCapturedDocToBankTx(COMPANY, DOC.toUpperCase(), TX, 'user-1');
    const insert = sqlMock.mock.calls.find((c) => (c[0] as readonly string[]).join('?').includes('INSERT INTO bank_transaction_attachments'))!;
    expect(insert.slice(1)).toContain(`${DOC}_slip.jpg`);
  });

  it('returns notFound when the document is not in this company', async () => {
    mockSqlByQuery(happyHandlers({ doc: [] }));
    const result = await attachCapturedDocToBankTx(COMPANY, DOC, TX, 'user-1');
    expect(result).toEqual({ ok: false, reason: 'document_not_found' });
  });

  it('returns notFound when the bank tx is not in this company (IDOR guard)', async () => {
    mockSqlByQuery(happyHandlers({ tx: [] }));
    const result = await attachCapturedDocToBankTx(COMPANY, DOC, TX, 'user-1');
    expect(result).toEqual({ ok: false, reason: 'bank_tx_not_found' });
  });

  it('links without mirroring when the file exceeds 2 MB', async () => {
    mockSqlByQuery(happyHandlers());
    vi.mocked(fetchRawBytes).mockResolvedValue({
      buffer: Buffer.alloc(2 * 1024 * 1024 + 1), hash: 'h', size: 2 * 1024 * 1024 + 1, fileType: 'jpeg',
    });
    const result = await attachCapturedDocToBankTx(COMPANY, DOC, TX, 'user-1');
    expect(result).toEqual({ ok: true, mirrored: false });
    const calls = sqlMock.mock.calls.map((c) => (c[0] as readonly string[]).join('?'));
    expect(calls.some((q) => q.includes('INSERT INTO bank_transaction_attachments'))).toBe(false);
    expect(calls.some((q) => q.includes('UPDATE captured_documents'))).toBe(true);
  });

  it('skips the mirror when the SAME document is already mirrored on this tx (dedupe)', async () => {
    // The mocked dup row stands in for an existing attachment stored under the
    // documentId-prefixed key (`${DOC}_slip.jpg`) — i.e. a retry of the SAME doc.
    mockSqlByQuery(happyHandlers({ dup: [{ id: 'existing' }] }));
    vi.mocked(fetchRawBytes).mockResolvedValue({
      buffer: Buffer.from('img'), hash: 'h', size: 3, fileType: 'jpeg',
    });
    const result = await attachCapturedDocToBankTx(COMPANY, DOC, TX, 'user-1');
    expect(result).toEqual({ ok: true, mirrored: true });
    const calls = sqlMock.mock.calls.map((c) => (c[0] as readonly string[]).join('?'));
    expect(calls.some((q) => q.includes('INSERT INTO bank_transaction_attachments'))).toBe(false);
    // The dedupe key is the document's id (any copy of it on this line, in any case), not the bare file name.
    const dupCall = sqlMock.mock.calls.find((c) =>
      (c[0] as readonly string[]).join('?').includes('SELECT id FROM bank_transaction_attachments'));
    expect(dupCall).toBeDefined();
    expect((dupCall![0] as readonly string[]).join('?')).toMatch(/lower\(left\(file_name, 37\)\)/);
    expect(dupCall!.slice(1)).toContain(DOC);
  });

  it('dedupes per-document: two different docs with the same original file name both mirror', async () => {
    const DOC2 = '44444444-4444-4444-4444-444444444444';
    vi.mocked(fetchRawBytes).mockResolvedValue({
      buffer: Buffer.from('img'), hash: 'h', size: 3, fileType: 'jpeg',
    });
    // The copy is named from the document's id as the database returns it, so each call returns its own row.
    mockSqlByQuery(happyHandlers()); // dup check returns [] for every doc
    expect(await attachCapturedDocToBankTx(COMPANY, DOC, TX, 'user-1'))
      .toEqual({ ok: true, mirrored: true });
    mockSqlByQuery(happyHandlers({ doc: [{ id: DOC2, file_name: 'slip.jpg', file_type: 'jpeg' }] }));
    expect(await attachCapturedDocToBankTx(COMPANY, DOC2, TX, 'user-1'))
      .toEqual({ ok: true, mirrored: true });

    const inserts = sqlMock.mock.calls.filter((c) =>
      (c[0] as readonly string[]).join('?').includes('INSERT INTO bank_transaction_attachments'));
    expect(inserts).toHaveLength(2);

    // Each dup check is keyed on its own document; each insert carries its own documentId-prefixed name.
    const dupChecks = sqlMock.mock.calls.filter((c) =>
      (c[0] as readonly string[]).join('?').includes('SELECT id FROM bank_transaction_attachments'));
    expect(dupChecks.map((c) => c.slice(1)).flat()).toEqual(expect.arrayContaining([DOC, DOC2]));
    expect(inserts.map((c) => c.slice(1)).flat()).toEqual(
      expect.arrayContaining([`${DOC}_slip.jpg`, `${DOC2}_slip.jpg`]),
    );
  });

  it('still links when raw bytes are unavailable (mirrored:false, warn logged)', async () => {
    mockSqlByQuery(happyHandlers());
    vi.mocked(fetchRawBytes).mockResolvedValue(null);
    const result = await attachCapturedDocToBankTx(COMPANY, DOC, TX, 'user-1');
    expect(result).toEqual({ ok: true, mirrored: false });
  });
});
