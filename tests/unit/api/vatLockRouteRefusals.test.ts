/**
 * Two routes that now answer a VAT-lock refusal with a 400 instead of a 500 —
 * and only because the refusal lands before their first write (withAuth
 * COMMITs a 4xx):
 *
 *   - receipt-to-journal runs the guard BEFORE claiming the captured document
 *     (its first write). The route cannot be driven on isaflow_dev (its row lock
 *     reads captured_documents.posted_at, migration 672), so it is pinned here
 *     with the database mocked: a refusal returns 400 and NO claim UPDATE and no
 *     journal call happens.
 *   - supplier-credit-notes PATCH maps the refusal cancelCreditNote /
 *     approveCreditNote raise before any write.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/als', () => ({
  als: { getStore: () => ({ client: { query: vi.fn() } }) },
  assertTxUsable: vi.fn(),
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn((_res: unknown, data: unknown) => ({ kind: 'success', data })),
    created: vi.fn((_res: unknown, data: unknown) => ({ kind: 'created', data })),
    badRequest: vi.fn((_res: unknown, error: string) => ({ kind: 'badRequest', error })),
    notFound: vi.fn((_res: unknown, entity: string) => ({ kind: 'notFound', entity })),
    methodNotAllowed: vi.fn(() => ({ kind: 'methodNotAllowed' })),
    internalError: vi.fn(() => ({ kind: 'internalError' })),
  },
}));

const m = vi.hoisted(() => ({
  sql: Object.assign(vi.fn(), { transaction: vi.fn() }),
  create: vi.fn(),
  post: vi.fn(),
  guard: vi.fn(),
  cancel: vi.fn(),
  getCn: vi.fn(),
}));
vi.mock('@/lib/neon', () => ({ sql: m.sql, withTransaction: vi.fn(), fmtDate: (d: unknown) => String(d) }));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({ createJournalEntry: m.create, postJournalEntry: m.post }));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({ getSystemAccountId: vi.fn(async (k: string) => `acct-${k}`) }));
// R-088's duplicate check has its own real-PG coverage (r088-receipt-content-dedupe); here it is clear.
vi.mock('@/modules/accounting/services/capture/receiptDuplicateGuard', () => ({
  checkReceiptDuplicate: vi.fn(async () => ({
    kind: 'clear', fingerprint: { receiptKey: null, duplicateOf: null, confirmedBy: null },
  })),
}));
vi.mock('@/modules/accounting/services/gl/journalVatLockGuard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/gl/journalVatLockGuard')>()),
  assertJournalVatPeriodOpen: m.guard,
}));
vi.mock('@/modules/accounting/services/ar/creditNoteService', () => ({
  getCreditNoteById: m.getCn, createCreditNote: vi.fn(), approveCreditNote: vi.fn(), cancelCreditNote: m.cancel,
}));

import receiptToJournal from '../../../pages/api/accounting/receipt-to-journal';
import supplierCreditNotes from '../../../pages/api/accounting/supplier-credit-notes';
import { VatPeriodLockedError } from '@/modules/accounting/services/gl/journalVatLockGuard';

const refusal = () => new VatPeriodLockedError('2026-06-10', { id: 'l', periodStart: '2026-05-01', periodEnd: '2026-06-30' });
const res = () => ({}) as NextApiResponse;
const RECEIPT = {
  totalAmount: 1150, subtotal: 1000, vatAmount: 150, vatRate: 15,
  date: '2026-06-10', vendorName: 'Waltons', confidence: 0.95,
};

beforeEach(() => {
  vi.clearAllMocks();
  m.sql.mockImplementation(((strings: TemplateStringsArray) => {
    const text = strings.join('');
    if (text.includes('FROM captured_documents')) return Promise.resolve([{ extracted_data: RECEIPT, status: 'pending' }]);
    if (text.includes('UPDATE captured_documents')) return Promise.resolve([{ id: 'doc-1' }]);
    return Promise.resolve([]);
  }) as never);
  m.guard.mockResolvedValue(undefined);
  m.create.mockResolvedValue({ id: 'je-1', status: 'draft' });
});

const claimCalls = () => m.sql.mock.calls.filter((c) => (c[0] as unknown as string[]).join('').includes('UPDATE captured_documents'));

describe('receipt-to-journal', () => {
  const call = () => (receiptToJournal as unknown as (r: unknown, s: NextApiResponse) => Promise<{ kind: string; error?: string }>)({
    method: 'POST', companyId: 'co-1', user: { id: 'u-1' }, body: { documentId: 'doc-1' }, query: {},
  }, res());

  it('answers a VAT-lock refusal with 400 BEFORE claiming the document or creating a journal', async () => {
    m.guard.mockRejectedValueOnce(refusal());
    const out = await call();
    expect(out).toMatchObject({ kind: 'badRequest' });
    expect(out.error).toMatch(/locked/);
    expect(claimCalls()).toHaveLength(0);
    expect(m.create).not.toHaveBeenCalled();
  });

  it('runs the guard with the receipt date and the VAT leg, and claims only after it passes', async () => {
    await call();
    expect(m.guard).toHaveBeenCalledTimes(1);
    expect(m.guard.mock.calls[0]![1]).toBe('2026-06-10');
    expect((m.guard.mock.calls[0]![2] as { glAccountId: string }[]).some((l) => l.glAccountId === 'acct-vat_input')).toBe(true);
    expect(claimCalls()).toHaveLength(1);
  });
});

describe('supplier-credit-notes PATCH reverse', () => {
  it('answers a VAT-lock refusal from the cancel with 400, not a 500', async () => {
    m.getCn.mockResolvedValue({ id: 'cn-1', type: 'supplier' });
    m.cancel.mockRejectedValueOnce(refusal());
    const out = await (supplierCreditNotes as unknown as (r: unknown, s: NextApiResponse) => Promise<{ kind: string }>)({
      method: 'PATCH', companyId: 'co-1', user: { id: 'u-1' }, body: { id: 'cn-1', action: 'reverse' }, query: {},
    }, res());
    expect(out).toMatchObject({ kind: 'badRequest' });
  });
});
