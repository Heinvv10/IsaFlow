/**
 * One tool for every entity type: attach_entity_document and list_documents take entity_type "bank_transaction" and
 * route to the bank-line store, so a caller never has to know the second store. attach_document stays.
 *
 * Load-bearing: the bank branch needs write:bank-tx on top of the tool's write:invoices; ownership is the bank line's
 * own and reads as the shared "Not found"; every refusal precedes the write; a re-run returns the existing file.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/core/bankLineDocumentRouting', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/accounting/services/core/bankLineDocumentRouting')>();
  return { ...real, bankTxBelongsToCompany: vi.fn(), findBankLineDuplicate: vi.fn() };
});
vi.mock('@/modules/accounting/services/bank/bankTxAttachmentService', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/accounting/services/bank/bankTxAttachmentService')>();
  return { ...real, addBankTxAttachment: vi.fn() };
});
vi.mock('@/modules/accounting/services/core/documentQueryService', () => ({
  listEntityDocuments: vi.fn(), listBankAttachments: vi.fn(), listTransactionsWithoutDocuments: vi.fn(),
}));
vi.mock('@/modules/accounting/services/core/documentStorageService', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/accounting/services/core/documentStorageService')>();
  return { ...real, verifyEntityOwnershipTyped: vi.fn(), findActiveDuplicate: vi.fn(), storeDocumentBytes: vi.fn() };
});
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { bankTxBelongsToCompany, findBankLineDuplicate } from '@/modules/accounting/services/core/bankLineDocumentRouting';
import { addBankTxAttachment } from '@/modules/accounting/services/bank/bankTxAttachmentService';
import { listBankAttachments, listEntityDocuments } from '@/modules/accounting/services/core/documentQueryService';
import { storeDocumentBytes, verifyEntityOwnershipTyped } from '@/modules/accounting/services/core/documentStorageService';
import { attachEntityDocumentTool, ATTACH_ENTITY_MAX_BYTES } from '@/lib/mcp/tools/writeAttachEntityDocument';
import { listDocumentsTool } from '@/lib/mcp/tools/documents';
import type { McpToolContext } from '@/lib/mcp/types';

const TX = '77777777-7777-4777-8777-777777777777';
const ctx = (scopes: string[]): McpToolContext => ({
  userId: '11111111-1111-1111-1111-111111111111', companyId: '22222222-2222-2222-2222-222222222222',
  scopes, tokenJti: 'j', oauthAppId: null,
});
const BOTH = ctx(['write:invoices', 'write:bank-tx']);
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const args = (over: Record<string, unknown> = {}) => ({
  entity_type: 'bank_transaction', entity_id: TX, file_name: 'slip.png', mime_type: 'image/png',
  content: PNG.toString('base64'), idempotency_key: 'k', ...over,
});
const stored = { id: 'a1', bankTransactionId: TX, fileName: 'slip.png', fileSize: PNG.length, mimeType: 'image/png', createdAt: '2026-11-13T10:00:00.000Z' };
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(bankTxBelongsToCompany).mockResolvedValue(true);
  vi.mocked(findBankLineDuplicate).mockResolvedValue(null);
  vi.mocked(addBankTxAttachment).mockResolvedValue({ ok: true, attachment: stored });
});

describe('attach_entity_document on a bank transaction', () => {
  it('offers bank_transaction in its entity_type enum', () => {
    const props = attachEntityDocumentTool.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.entity_type!.enum).toContain('bank_transaction');
  });

  it('stores the file on the line under the token\'s company and user, and says what it stored', async () => {
    const res = await attachEntityDocumentTool.handler(args(), BOTH);
    expect(res.isError).toBeFalsy();
    expect(bankTxBelongsToCompany).toHaveBeenCalledWith(BOTH.companyId, TX);
    const input = vi.mocked(addBankTxAttachment).mock.calls[0]!;
    expect(input[0]).toBe(BOTH.companyId);
    expect(input[1]).toMatchObject({ bankTransactionId: TX, fileName: 'slip.png', mimeType: 'image/png', maxBytes: ATTACH_ENTITY_MAX_BYTES, uploadedBy: BOTH.userId });
    expect(Buffer.compare(input[1].bytes, PNG)).toBe(0);
    expect(verifyEntityOwnershipTyped).not.toHaveBeenCalled();
    expect(storeDocumentBytes).not.toHaveBeenCalled();
    expect(JSON.parse(text(res))).toMatchObject({
      document_id: 'a1', entity_type: 'bank_transaction', entity_id: TX, file_name: 'slip.png', duplicate: false,
    });
  });

  it('needs write:bank-tx as well as write:invoices, and refuses before reading anything', async () => {
    const res = await attachEntityDocumentTool.handler(args(), ctx(['write:invoices']));
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('write:bank-tx');
    expect(bankTxBelongsToCompany).not.toHaveBeenCalled();
    expect(addBankTxAttachment).not.toHaveBeenCalled();
  });

  it('reads another company\'s or a missing line as the shared Not found', async () => {
    vi.mocked(bankTxBelongsToCompany).mockResolvedValue(false);
    const res = await attachEntityDocumentTool.handler(args(), BOTH);
    expect(res.isError).toBe(true);
    expect(text(res)).toBe('Not found');
    expect(addBankTxAttachment).not.toHaveBeenCalled();
  });

  it('refuses a file type a bank line cannot hold (docx) before any write', async () => {
    const res = await attachEntityDocumentTool.handler(args({
      mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      content: Buffer.from('504b0304', 'hex').toString('base64'), file_name: 'x.docx',
    }), BOTH);
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('image/png');
    expect(addBankTxAttachment).not.toHaveBeenCalled();
  });

  it('refuses bytes that are not the declared type, and a file over the cap', async () => {
    const spoof = await attachEntityDocumentTool.handler(args({ content: Buffer.from('504b0304', 'hex').toString('base64') }), BOTH);
    expect(spoof.isError).toBe(true);
    const big = await attachEntityDocumentTool.handler(args({ content: Buffer.concat([PNG, Buffer.alloc(ATTACH_ENTITY_MAX_BYTES)]).toString('base64') }), BOTH);
    expect(big.isError).toBe(true);
    expect(addBankTxAttachment).not.toHaveBeenCalled();
  });

  it('refuses an id that is not a UUID instead of casting it', async () => {
    const res = await attachEntityDocumentTool.handler(args({ entity_id: 'abc' }), BOTH);
    expect(res.isError).toBe(true);
    expect(bankTxBelongsToCompany).not.toHaveBeenCalled();
  });

  it('a re-run returns the file already on the line with duplicate: true and stores nothing', async () => {
    vi.mocked(findBankLineDuplicate).mockResolvedValue({
      id: 'a0', entityType: 'bank_transaction', entityId: TX, documentType: 'other', documentName: 'slip.png', fileUrl: '',
      fileSize: PNG.length, mimeType: 'image/png', uploadedBy: '', uploadedAt: '2026-11-12T10:00:00.000Z', isActive: true, source: 'direct',
    });
    const res = await attachEntityDocumentTool.handler(args(), BOTH);
    expect(JSON.parse(text(res))).toMatchObject({ document_id: 'a0', duplicate: true });
    expect(addBankTxAttachment).not.toHaveBeenCalled();
  });

  it('maps the service\'s own pre-write refusals to tool errors', async () => {
    vi.mocked(addBankTxAttachment).mockResolvedValue({ ok: false, reason: 'bank_tx_not_found' });
    const res = await attachEntityDocumentTool.handler(args(), BOTH);
    expect(res.isError).toBe(true);
    expect(text(res)).toBe('Not found');
  });

  it('leaves the existing entity types on the entity store', async () => {
    vi.mocked(verifyEntityOwnershipTyped).mockResolvedValue(true);
    vi.mocked(storeDocumentBytes).mockResolvedValue({
      id: 'd1', entityType: 'supplier_invoice', entityId: TX, documentType: 'invoice', documentName: 'b.pdf', fileUrl: 'u',
      uploadedBy: 'u', uploadedAt: '2026-11-13T00:00:00.000Z', isActive: true, source: 'direct',
    });
    const pdf = Buffer.from('%PDF-1.4\n', 'latin1');
    const res = await attachEntityDocumentTool.handler(
      args({ entity_type: 'supplier_invoice', mime_type: 'application/pdf', content: pdf.toString('base64') }), ctx(['write:invoices']));
    expect(res.isError).toBeFalsy();
    expect(storeDocumentBytes).toHaveBeenCalled();
    expect(addBankTxAttachment).not.toHaveBeenCalled();
  });
});

describe('list_documents on a bank transaction', () => {
  const read = ctx(['read:reports', 'read:bank-tx']);
  const bankPage = {
    rows: [{
      id: 'a1', store: 'bank_attachment' as const, bankTransactionId: TX, fileName: 'slip.png', fileSize: 8, uploadedBy: null,
      createdAt: '2026-11-13T10:00:00.000Z', transactionDate: '2026-11-01', amount: -120, transactionDescription: 'Makro', reference: 'R1',
    }],
    rowsTotal: 1, postedThrough: '2026-11-13T10:00:00.000Z',
  };

  it('takes entity_type bank_transaction + entity_id with no date range and returns the line\'s documents', async () => {
    vi.mocked(listBankAttachments).mockResolvedValue(bankPage);
    const res = await listDocumentsTool.handler({ entity_type: 'bank_transaction', entity_id: TX }, read);
    expect(res.isError).toBeFalsy();
    expect(vi.mocked(listBankAttachments).mock.calls[0]).toEqual([read.companyId, expect.objectContaining({ bankTransactionId: TX })]);
    expect(listEntityDocuments).not.toHaveBeenCalled();
    const body = JSON.parse(text(res)) as { rows: Record<string, unknown>[] };
    expect(body.rows[0]).toMatchObject({ store: 'bank_attachment', id: 'a1', entity_type: 'bank_transaction', entity_id: TX, file_name: 'slip.png' });
  });

  it('needs read:bank-tx for a bank line, like list_missing_documents, and reads nothing without it', async () => {
    const res = await listDocumentsTool.handler({ entity_type: 'bank_transaction', entity_id: TX }, ctx(['read:reports']));
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('read:bank-tx');
    expect(bankTxBelongsToCompany).not.toHaveBeenCalled();
    expect(listBankAttachments).not.toHaveBeenCalled();
  });

  it('reads another company\'s line as Not found without listing', async () => {
    vi.mocked(bankTxBelongsToCompany).mockResolvedValue(false);
    const res = await listDocumentsTool.handler({ entity_type: 'bank_transaction', entity_id: TX }, read);
    expect(res.isError).toBe(true);
    expect(text(res)).toBe('Not found');
    expect(listBankAttachments).not.toHaveBeenCalled();
  });

  it('still answers the date-range bank listing and the entity store as before', async () => {
    vi.mocked(listBankAttachments).mockResolvedValue(bankPage);
    const byRange = await listDocumentsTool.handler({ from: '2026-11-01', to: '2026-11-30' }, read);
    expect(byRange.isError).toBeFalsy();
    vi.mocked(listEntityDocuments).mockResolvedValue({ ok: true, hasMore: false, documents: [] });
    const bill = await listDocumentsTool.handler({ entity_type: 'supplier_invoice', entity_id: TX }, read);
    expect(bill.isError).toBeFalsy();
    expect(listEntityDocuments).toHaveBeenCalled();
  });

  it('lists bank_transaction among the accepted entity types', () => {
    const props = listDocumentsTool.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.entity_type!.enum).toContain('bank_transaction');
  });
});
