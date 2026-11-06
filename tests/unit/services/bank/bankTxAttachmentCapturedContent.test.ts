/**
 * MCP get_document on a captured document linked to a bank line (store 'captured_document'): metadata always, content
 * only when asked, typed from the bytes, and left out past MAX_CAPTURED_CONTENT_BYTES ('too_large') or when the
 * stored object is gone ('missing'). Scope (company, bank link, not rejected) is proven against Postgres in
 * tests/integration/captured-attachment-routes.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlMock, fetchRaw } = vi.hoisted(() => ({ sqlMock: vi.fn(), fetchRaw: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: Object.assign(sqlMock, { unsafe: (t: string) => t }) }));
vi.mock('@/lib/documentStorage', () => ({ fetchRawBytes: fetchRaw }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { getBankTxAttachment, MAX_CAPTURED_CONTENT_BYTES } from '@/modules/accounting/services/bank/bankTxAttachmentService';

const DOC = '22222222-2222-4222-8222-222222222222';
const docRow = (size: number) => ({ id: DOC, bank_transaction_id: 'tx1', file_name: 'scan.pdf', file_size: size, created_at: '2026-06-01T00:00:00Z', file_type: 'application/pdf' });
const PDF = Buffer.from('%PDF-1.7\n...');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

beforeEach(() => {
  sqlMock.mockReset();
  fetchRaw.mockReset();
});
// First query: no upload with that id. Second: the linked captured document.
const serve = (row: unknown) => sqlMock.mockResolvedValueOnce([]).mockResolvedValueOnce(row ? [row] : []);

describe('get_document on a captured document', () => {
  it('returns its metadata under the claimed type, without content unless asked', async () => {
    serve(docRow(7_400_000));
    const doc = await getBankTxAttachment('co-1', DOC);
    expect(doc).toMatchObject({ id: DOC, store: 'captured_document', mimeType: 'application/pdf', fileSize: 7_400_000 });
    expect(doc!.content).toBeUndefined();
    expect(fetchRaw).not.toHaveBeenCalled();
  });

  it('returns content typed from its bytes, read for this company', async () => {
    serve(docRow(PNG.length));
    fetchRaw.mockResolvedValue({ buffer: PNG, hash: 'h', storedHash: 'h', size: PNG.length, fileType: 'application/pdf' });
    const doc = await getBankTxAttachment('co-1', DOC, true);
    expect(fetchRaw).toHaveBeenCalledWith(DOC, 'co-1');
    expect(doc).toMatchObject({ mimeType: 'image/png', content: PNG.toString('base64') });
    expect(doc!.contentOmitted).toBeUndefined();
  });

  it('leaves content out as too_large past the limit, by its recorded size before fetching and by its bytes after', async () => {
    serve(docRow(MAX_CAPTURED_CONTENT_BYTES + 1));
    expect(await getBankTxAttachment('co-1', DOC, true)).toMatchObject({ contentOmitted: 'too_large' });
    expect(fetchRaw).not.toHaveBeenCalled();

    const big = Buffer.concat([PDF, Buffer.alloc(MAX_CAPTURED_CONTENT_BYTES)]);
    serve(docRow(10));
    fetchRaw.mockResolvedValue({ buffer: big, hash: 'h', storedHash: 'h', size: big.length, fileType: 'pdf' });
    const doc = await getBankTxAttachment('co-1', DOC, true);
    expect(doc).toMatchObject({ contentOmitted: 'too_large' });
    expect(doc!.content).toBeUndefined();
  });

  it('returns content at exactly the limit', async () => {
    const exact = Buffer.concat([PDF, Buffer.alloc(MAX_CAPTURED_CONTENT_BYTES - PDF.length)]);
    serve(docRow(MAX_CAPTURED_CONTENT_BYTES));
    fetchRaw.mockResolvedValue({ buffer: exact, hash: 'h', storedHash: 'h', size: exact.length, fileType: 'pdf' });
    const doc = await getBankTxAttachment('co-1', DOC, true);
    expect(doc!.contentOmitted).toBeUndefined();
    expect(doc!.content).toHaveLength(Math.ceil(exact.length / 3) * 4);
  });

  it('says the content is missing when the stored object is gone', async () => {
    serve(docRow(10));
    fetchRaw.mockResolvedValue(null);
    expect(await getBankTxAttachment('co-1', DOC, true)).toMatchObject({ contentOmitted: 'missing' });
  });

  it('finds nothing when the id is neither an upload nor a linked captured document', async () => {
    serve(null);
    expect(await getBankTxAttachment('co-1', DOC, true)).toBeNull();
    const scope = (sqlMock.mock.calls[1]![0] as readonly string[]).join('?');
    expect(scope).toMatch(/cd\.company_id = \?::UUID/);
  });
});
