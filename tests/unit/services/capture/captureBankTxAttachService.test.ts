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

  it('skips the mirror when an attachment with the same file name already exists (dedupe)', async () => {
    mockSqlByQuery(happyHandlers({ dup: [{ id: 'existing' }] }));
    vi.mocked(fetchRawBytes).mockResolvedValue({
      buffer: Buffer.from('img'), hash: 'h', size: 3, fileType: 'jpeg',
    });
    const result = await attachCapturedDocToBankTx(COMPANY, DOC, TX, 'user-1');
    expect(result).toEqual({ ok: true, mirrored: true });
    const calls = sqlMock.mock.calls.map((c) => (c[0] as readonly string[]).join('?'));
    expect(calls.some((q) => q.includes('INSERT INTO bank_transaction_attachments'))).toBe(false);
  });

  it('still links when raw bytes are unavailable (mirrored:false, warn logged)', async () => {
    mockSqlByQuery(happyHandlers());
    vi.mocked(fetchRawBytes).mockResolvedValue(null);
    const result = await attachCapturedDocToBankTx(COMPANY, DOC, TX, 'user-1');
    expect(result).toEqual({ ok: true, mirrored: false });
  });
});
