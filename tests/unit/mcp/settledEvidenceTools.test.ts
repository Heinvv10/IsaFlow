/**
 * Settled-document evidence in the MCP document tools: list_unsupported_transactions' evidence column, totals, strict
 * and exclude_transfers; list_documents' settled_documents on a bank line. The query itself is proven against Postgres
 * in tests/integration/bank-settled-evidence.int.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/core/documentQueryService', () => ({
  listEntityDocuments: vi.fn(), listBankAttachments: vi.fn(), listTransactionsWithoutDocuments: vi.fn(),
}));
vi.mock('@/modules/accounting/services/core/bankLineDocumentRouting', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/accounting/services/core/bankLineDocumentRouting')>();
  return { ...real, bankTxBelongsToCompany: vi.fn(async () => true) };
});
vi.mock('@/modules/accounting/services/bank/settledDocumentService', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/accounting/services/bank/settledDocumentService')>();
  return { ...real, listSettledDocuments: vi.fn() };
});
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { listBankAttachments, listTransactionsWithoutDocuments } from '@/modules/accounting/services/core/documentQueryService';
import { listSettledDocuments, type SettledDocument } from '@/modules/accounting/services/bank/settledDocumentService';
import { listDocumentsTool, listUnsupportedTransactionsTool } from '@/lib/mcp/tools/documents';

const TX = '77777777-7777-4777-8777-777777777777';
const ctx = {
  companyId: '11111111-1111-4111-8111-111111111111', userId: 'u1',
  scopes: ['read:reports', 'read:bank-tx'], tokenJti: 't', oauthAppId: null,
} as never;
const body = (res: { content: { text: string }[] }) => JSON.parse(res.content[0]!.text) as Record<string, unknown>;

const page = {
  rows: [
    { id: 'tx1', transactionDate: '2026-11-02', amount: -1200, description: 'Fuel', reference: null, status: 'allocated', evidence: 'none' as const },
  ],
  rowsTotal: 547, universeTotal: 621, withOwnDocument: 74, withSettledDocument: 300, noEvidence: 247,
  postedThrough: '2026-11-17T00:00:00.000Z',
};

beforeEach(() => vi.clearAllMocks());

describe('list_unsupported_transactions evidence', () => {
  it('returns evidence per row and the three totals, unsupported = no evidence by default', async () => {
    vi.mocked(listTransactionsWithoutDocuments).mockResolvedValue(page);
    const out = body(await listUnsupportedTransactionsTool.handler({ from: '2026-11-01', to: '2026-11-17', min_amount: 1000 }, ctx) as never);
    expect(vi.mocked(listTransactionsWithoutDocuments).mock.calls[0]![1]).toMatchObject({
      strict: false, excludeTransfers: false, transferAccountCodes: [],
    });
    expect((out.rows as Record<string, unknown>[])[0]!.evidence).toBe('none');
    expect(out).toMatchObject({
      transactions_in_scope: 621, with_own_document: 74, with_settled_document: 300, no_evidence: 247,
      transactions_with_a_document: 74, strict: false, exclude_transfers: false,
    });
  });

  it('passes strict, exclude_transfers and the caller\'s clearing codes through', async () => {
    vi.mocked(listTransactionsWithoutDocuments).mockResolvedValue(page);
    const out = body(await listUnsupportedTransactionsTool.handler({
      from: '2026-11-01', to: '2026-11-17', strict: true, exclude_transfers: true, transfer_account_codes: ['1150', '1560731'],
    }, ctx) as never);
    expect(vi.mocked(listTransactionsWithoutDocuments).mock.calls[0]![1]).toMatchObject({
      strict: true, excludeTransfers: true, transferAccountCodes: ['1150', '1560731'],
    });
    expect(out).toMatchObject({ strict: true, exclude_transfers: true });
  });

  it.each([['not an array', '1150'], ['a non-string', [1150]], ['an empty code', ['']], ['too many', Array(21).fill('1')]])(
    'refuses transfer_account_codes that is %s, reading nothing', async (_label, codes) => {
      const res = await listUnsupportedTransactionsTool.handler(
        { from: '2026-11-01', to: '2026-11-17', exclude_transfers: true, transfer_account_codes: codes }, ctx);
      expect(res.isError).toBe(true);
      expect(listTransactionsWithoutDocuments).not.toHaveBeenCalled();
    });
});

describe('list_documents settled_documents on a bank line', () => {
  const settled: SettledDocument = {
    source: 'settled_document', documentId: 'd1', store: 'entity', fileName: 'SIV-3.pdf', mimeType: 'application/pdf',
    fileSize: 100, fileUrl: 'https://files.test/SIV-3.pdf', createdAt: '2026-10-20T00:00:00.000Z',
    via: { kind: 'supplier_payment', paymentId: 'p2', paymentNumber: 'SP-2' },
    settles: { entityType: 'supplier_invoice', entityId: 'b3', number: 'SIV-3', total: 1000, applied: 300, partial: true,
      invoiceId: 'b3', invoiceNumber: 'SIV-3' },
  };
  const bankPage = { rows: [], rowsTotal: 0, postedThrough: '2026-11-13T10:00:00.000Z' };

  it('adds the settled documents, marked source settled_document with via and settles, on the first page', async () => {
    vi.mocked(listBankAttachments).mockResolvedValue(bankPage);
    vi.mocked(listSettledDocuments).mockResolvedValue([settled]);
    const out = body(await listDocumentsTool.handler({ entity_type: 'bank_transaction', entity_id: TX }, ctx) as never);
    expect(vi.mocked(listSettledDocuments).mock.calls[0]).toEqual(['11111111-1111-4111-8111-111111111111', TX]);
    expect(out.rows).toEqual([]);
    expect(out.settled_documents).toEqual([expect.objectContaining({
      source: 'settled_document', document_id: 'd1', file_name: 'SIV-3.pdf',
      via: { kind: 'supplier_payment', payment_id: 'p2', payment_number: 'SP-2' },
      settles: expect.objectContaining({ number: 'SIV-3', applied: 300, total: 1000, partial: true }),
    })]);
  });

  it('does not repeat them on a later page', async () => {
    vi.mocked(listBankAttachments).mockResolvedValue(bankPage);
    const out = body(await listDocumentsTool.handler({ entity_type: 'bank_transaction', entity_id: TX, offset: 50 }, ctx) as never);
    expect(listSettledDocuments).not.toHaveBeenCalled();
    expect(out.settled_documents).toBeUndefined();
  });
});
