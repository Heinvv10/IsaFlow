/**
 * D8 round 11 (review rev-d8-c553cc0f8 F6, and the route census): round 10 put the automatic evidence attach under a
 * 5 s flow lock budget, and its catch-all turned that timeout into "nothing attached" — the capture post went on, the
 * bill posted, and the provisional stayed unevidenced where before it waited and attached. A lock timeout now
 * propagates (the savepoint rolled the attach back), so `withErrorHandler` answers 503 + Retry-After and the whole
 * capture post is retried. The settle step that follows does the same, instead of withdrawing the auto-approval.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: Object.assign(vi.fn(), { unsafe: vi.fn().mockReturnValue('') }) }));
vi.mock('@/lib/neon', () => ({
  sql: sqlMock,
  fmtDate: (x: unknown) => String(x),
  withSavepoint: <T>(_name: string, fn: () => Promise<T>) => fn(),
}));
vi.mock('@/modules/accounting/services/shared/journalChainHead', async (original) => ({
  ...await original<typeof import('@/modules/accounting/services/shared/journalChainHead')>(),
  findJournalChainHead: vi.fn(async (_c: string, id: string) => ({ kind: 'head', id, standing: true })),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const postSupplierInvoiceToGL = vi.fn();
vi.mock('@/modules/accounting/services/ap/supplierInvoiceWorkflowService', () => ({
  postSupplierInvoiceToGL: (...a: unknown[]) => postSupplierInvoiceToGL(...a),
}));

import { attachEvidenceToProvisional } from '@/modules/accounting/services/capture/evidenceAttachmentService';
import { attachEvidenceAndSettleApproved } from '@/modules/accounting/services/capture/provisionalAttachSettle';
import { RowLockTimeoutError } from '@/modules/accounting/services/core/rowLockBudget';
import { BankTransactionLockTimeoutError } from '@/modules/accounting/services/bank/bankTxLock';

const DOC = 'cccccccc-0000-0000-0000-000000000003';
const INPUT = {
  companyId: 'aaaaaaaa-0000-0000-0000-000000000001', userId: 'u', documentId: DOC,
  invoiceId: 'ffffffff-0000-0000-0000-000000000006', invoiceStatus: 'approved',
  supplierId: 'bbbbbbbb-0000-0000-0000-000000000002', totalAmount: 1200, invoiceDate: '2026-04-10',
};

/** The attach's reads all succeed; its bank-line UPDATE answers `bankUpdate`. */
function attachReaches(bankUpdate: () => Promise<unknown>) {
  sqlMock.mockImplementation((strings: TemplateStringsArray) => {
    const t = strings.join('?');
    if (/FROM captured_documents/.test(t)) return Promise.resolve([{ id: DOC, raw_bytes_sha256: 'h', extracted_data: {} }]);
    if (/JOIN bank_transactions bt/.test(t)) return Promise.resolve([{ je_id: 'je-1', bt_id: 'bt-1' }]);
    if (/UPDATE bank_transactions/.test(t)) return bankUpdate();
    if (/UPDATE gl_journal_entries/.test(t)) return Promise.resolve([{ id: 'je-1' }]);
    return Promise.resolve([]);
  });
}
const draftReverts = () => sqlMock.mock.calls.filter((c) => /SET status = 'draft'/.test((c[0] as TemplateStringsArray).join('?')));

beforeEach(() => { sqlMock.mockReset(); postSupplierInvoiceToGL.mockReset(); });

describe('attachEvidenceToProvisional', () => {
  it.each([
    ['RowLockTimeoutError', () => new RowLockTimeoutError(`Captured document ${DOC}`)],
    ['BankTransactionLockTimeoutError', () => new BankTransactionLockTimeoutError('bt-1')],
  ])('surfaces a %s as itself, not "nothing attached"', async (_n, make) => {
    const err = make();
    attachReaches(() => Promise.reject(err));
    await expect(attachEvidenceToProvisional(INPUT.companyId, DOC, INPUT.supplierId, 1200, '2026-04-10')).rejects.toBe(err);
  });

  it('still answers any other failure "nothing attached" — the attach is best-effort', async () => {
    attachReaches(() => Promise.reject(new Error('boom')));
    await expect(attachEvidenceToProvisional(INPUT.companyId, DOC, INPUT.supplierId, 1200, '2026-04-10'))
      .resolves.toEqual({ attachedJeId: null, bankTxId: null });
  });
});

describe('attachEvidenceAndSettleApproved', () => {
  it('a lock timeout in the settlement propagates; the auto-approval is not withdrawn', async () => {
    attachReaches(() => Promise.resolve([]));
    const err = new RowLockTimeoutError('Provisional entry je-1');
    postSupplierInvoiceToGL.mockRejectedValueOnce(err);
    await expect(attachEvidenceAndSettleApproved(INPUT)).rejects.toBe(err);
    expect(draftReverts()).toHaveLength(0);
  });

  it('any other settlement failure still withdraws the auto-approval to draft', async () => {
    attachReaches(() => Promise.resolve([]));
    postSupplierInvoiceToGL.mockRejectedValueOnce(new Error('no line items'));
    const r = await attachEvidenceAndSettleApproved(INPUT);
    expect(r.settlementRefused).toBe('no line items');
    expect(draftReverts()).toHaveLength(1);
  });
});
