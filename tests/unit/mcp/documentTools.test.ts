import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/core/documentQueryService', () => ({
  listEntityDocuments: vi.fn(),
  listBankAttachments: vi.fn(),
  listTransactionsWithoutDocuments: vi.fn(),
}));
vi.mock('@/modules/accounting/services/core/documentStorageService', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@/modules/accounting/services/core/documentStorageService');
  return { ...actual };
});
vi.mock('@/modules/accounting/services/bank/bankTxAttachmentService', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@/modules/accounting/services/bank/bankTxAttachmentService');
  return { ...actual, getBankTxAttachment: vi.fn() };
});

import {
  listBankAttachments,
  listEntityDocuments,
  listTransactionsWithoutDocuments,
} from '@/modules/accounting/services/core/documentQueryService';
import { getBankTxAttachment } from '@/modules/accounting/services/bank/bankTxAttachmentService';
import {
  listDocumentsTool,
  getDocumentTool,
  listUnsupportedTransactionsTool,
} from '@/lib/mcp/tools/documents';
import { assertEnvelopeSound } from '@/lib/mcp/contracts';

const ctx = {
  companyId: '11111111-1111-4111-8111-111111111111',
  userId: 'u1', scopes: ['read:reports'], tokenJti: 't', oauthAppId: null,
} as never;

function payload(res: { content: { text: string }[] }) {
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
}

beforeEach(() => vi.clearAllMocks());

describe('list_documents', () => {
  it('is read-only on read:reports', () => {
    expect(listDocumentsTool.write).toBe(false);
    expect(listDocumentsTool.scope).toBe('read:reports');
  });

  it('lists bank attachments over a date range when no entity is named', async () => {
    vi.mocked(listBankAttachments).mockResolvedValue({
      rows: [{
        id: 'a1', bankTransactionId: 'tx1', fileName: 'slip.pdf', fileSize: 100,
        uploadedBy: null, createdAt: '2026-09-01T00:00:00.000Z', transactionDate: '2026-09-01',
        amount: -12000, transactionDescription: 'Makro', reference: 'R1',
      }],
      rowsTotal: 1, postedThrough: '2026-09-01T00:00:00.000Z',
    });
    const env = payload(await listDocumentsTool.handler({ from: '2026-09-01', to: '2026-09-30' }, ctx) as never);
    assertEnvelopeSound(env as never);
    expect(vi.mocked(listBankAttachments).mock.calls[0]![0]).toBe(ctx.companyId);
    expect((env.rows as Record<string, unknown>[])[0]!.store).toBe('bank_attachment');
    expect(env.posted_through).toBe('2026-09-01T00:00:00.000Z');
  });

  it('reads the entity store when entity_type and entity_id are given', async () => {
    vi.mocked(listEntityDocuments).mockResolvedValue({ ok: true, hasMore: false, documents: [] } as never);
    const env = payload(await listDocumentsTool.handler(
      { entity_type: 'customer_invoice', entity_id: '22222222-2222-4222-8222-222222222222' }, ctx) as never);
    expect(listEntityDocuments).toHaveBeenCalled();
    expect(env.rows).toEqual([]);
  });

  it('returns the shared not-found text for another company\'s entity — never a distinct reply', async () => {
    vi.mocked(listEntityDocuments).mockResolvedValue({ ok: false, reason: 'entity_not_found' } as never);
    const res = await listDocumentsTool.handler(
      { entity_type: 'customer_invoice', entity_id: '22222222-2222-4222-8222-222222222222' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe('Not found');
  });

  it('refuses an entity_id that is not a UUID before it reaches a ::uuid cast', async () => {
    const res = await listDocumentsTool.handler({ entity_type: 'customer_invoice', entity_id: 'nope' }, ctx);
    expect(res.isError).toBe(true);
    expect(listEntityDocuments).not.toHaveBeenCalled();
  });

  it('requires a date range when listing the bank store', async () => {
    const res = await listDocumentsTool.handler({}, ctx);
    expect(res.isError).toBe(true);
    expect(listBankAttachments).not.toHaveBeenCalled();
  });
});

describe('list_unsupported_transactions', () => {
  it('answers the audit test the specification names', async () => {
    vi.mocked(listTransactionsWithoutDocuments).mockResolvedValue({
      rows: [{ id: 'tx1', transactionDate: '2026-09-01', amount: -12000, description: 'Cash', reference: null, status: 'allocated' }],
      rowsTotal: 1, universeTotal: 40, postedThrough: '2026-09-01T00:00:00.000Z',
    });
    const env = payload(await listUnsupportedTransactionsTool.handler(
      { from: '2026-01-01', to: '2026-12-31', min_amount: 10000 }, ctx) as never);

    // rowsTotal + excluded must account for the universe, or buildEnvelope
    // records a fault — here the "excluded" rows are the SUPPORTED ones.
    expect(env.rowsTotal).toBe(1);
    expect(env.universeTotal).toBeUndefined();
    expect(env.transactions_in_scope).toBe(40);
    expect(env.transactions_with_a_document).toBe(39);
    expect((env.rows as Record<string, unknown>[])[0]!.amount).toBe(-12000);
  });

  it('defaults min_amount to 0 rather than silently picking a materiality level', async () => {
    vi.mocked(listTransactionsWithoutDocuments).mockResolvedValue({
      rows: [], rowsTotal: 0, universeTotal: 0, postedThrough: '2026-09-01T00:00:00.000Z',
    });
    await listUnsupportedTransactionsTool.handler({ from: '2026-01-01', to: '2026-12-31' }, ctx);
    expect(vi.mocked(listTransactionsWithoutDocuments).mock.calls[0]![1].minAmount).toBe(0);
  });

  it('refuses a negative min_amount — the comparison is on absolute value', async () => {
    const res = await listUnsupportedTransactionsTool.handler(
      { from: '2026-01-01', to: '2026-12-31', min_amount: -5 }, ctx);
    expect(res.isError).toBe(true);
    expect(listTransactionsWithoutDocuments).not.toHaveBeenCalled();
  });
});

describe('get_document', () => {
  it('does not ask for the bytes unless include_content was set', async () => {
    // The service decides whether to read file_url; the tool must not ask for
    // several hundred KB of base64 on an ordinary metadata lookup.
    vi.mocked(getBankTxAttachment).mockImplementation(async (_c, _id, include) => ({
      id: 'a1', bankTransactionId: 'tx1', fileName: 'slip.pdf', fileSize: 10,
      mimeType: 'application/pdf', createdAt: '2026-09-01T00:00:00.000Z',
      ...(include ? { content: 'AAA' } : {}),
    }) as never);
    const res = payload(await getDocumentTool.handler(
      { document_id: '33333333-3333-4333-8333-333333333333' }, ctx) as never);
    expect(vi.mocked(getBankTxAttachment).mock.calls[0]![2]).toBe(false);
    expect(res.file_name).toBe('slip.pdf');
    expect(res.content).toBeUndefined();
  });

  it('returns the bytes when include_content is set', async () => {
    vi.mocked(getBankTxAttachment).mockResolvedValue({
      id: 'a1', bankTransactionId: 'tx1', fileName: 'slip.pdf', fileSize: 10,
      mimeType: 'application/pdf', createdAt: '2026-09-01T00:00:00.000Z', content: 'AAA',
    } as never);
    const res = payload(await getDocumentTool.handler(
      { document_id: '33333333-3333-4333-8333-333333333333', include_content: true }, ctx) as never);
    expect(res.content).toBe('AAA');
  });

  it('is the same "Not found" for another company\'s document as for a missing one', async () => {
    vi.mocked(getBankTxAttachment).mockResolvedValue(null);
    const res = await getDocumentTool.handler(
      { document_id: '33333333-3333-4333-8333-333333333333' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe('Not found');
  });
});
