/**
 * D8 round 11 (review rev-d8-c553cc0f8 F1, and the census of every route that reaches a D8 flow): the routes whose
 * own catch answered a lock timeout before `withErrorHandler` could map it.
 *   · supplier-credit-notes PATCH reverse (`cancelCreditNote`): 500, no Retry-After.
 *   · journal-entries-action reverse (`reverseJournalEntry`, its chain-head claim): 400.
 *   · soft-delete POST / PUT (`prepareInvoiceDelete` / `reinstateInvoiceJournal`): 500.
 *   · bank-auto-post undo (`reverseReconciledTransaction` under its flow budget): 400.
 * Each now answers 503 + Retry-After; an ordinary failure keeps its old status.
 * `withErrorHandler` is replaced by a stand-in with the real lock-timeout mapping (`respondIfLockTimeout`), so a
 * route that rethrows is judged by what the real wrapper would answer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', async () => {
  const { respondIfLockTimeout } = await import('@/lib/apiDocumentLock');
  return {
    withErrorHandler: (h: (req: unknown, res: NextApiResponse) => unknown) => async (req: unknown, res: NextApiResponse) => {
      try { return await h(req, res); } catch (err) {
        if (!respondIfLockTimeout(res, err)) res.status(500).json({ success: false });
      }
    },
  };
});
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/creditNoteService', () => ({
  getCreditNotes: vi.fn(), getCreditNoteById: vi.fn(), createCreditNote: vi.fn(), approveCreditNote: vi.fn(),
  cancelCreditNote: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({ postJournalEntry: vi.fn(), reverseJournalEntry: vi.fn() }));
vi.mock('@/modules/accounting/services/core/softDeleteService', () => ({
  softDelete: vi.fn(), undoDelete: vi.fn(), isValidEntityType: () => true,
}));
vi.mock('@/modules/accounting/services/bank/autoPostGateService', () => ({ getAutoPostSettings: vi.fn(), updateAutoPostSettings: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/autoPostUndoService', () => ({ undoRun: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/autoPostHandCorrection', () => ({
  HandCorrectionRefusedError: class extends Error {}, markCorrectedByHand: vi.fn(), undoAnyway: vi.fn(),
}));

import { cancelCreditNote, getCreditNoteById } from '@/modules/accounting/services/ar/creditNoteService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { softDelete, undoDelete } from '@/modules/accounting/services/core/softDeleteService';
import { undoRun } from '@/modules/accounting/services/bank/autoPostUndoService';
import { undoAnyway } from '@/modules/accounting/services/bank/autoPostHandCorrection';
import { JournalReversalLockTimeoutError } from '@/modules/accounting/services/gl/journalEntryReversalClaim';
import { RowLockTimeoutError } from '@/modules/accounting/services/core/rowLockBudget';
import { BankTransactionLockTimeoutError } from '@/modules/accounting/services/bank/bankTxLock';
import supplierCreditNotes from '../../../pages/api/accounting/supplier-credit-notes';
import journalEntriesAction from '../../../pages/api/accounting/journal-entries-action';
import softDeleteRoute from '../../../pages/api/accounting/soft-delete';
import bankAutoPost from '../../../pages/api/accounting/bank-auto-post';

const ID = '66666666-6666-4666-8666-666666666666';
const ID2 = '77777777-7777-4777-8777-777777777777';
const ID3 = '88888888-8888-4888-8888-888888888888';

function call(handler: unknown, method: string, body: unknown) {
  const req = { method, query: {}, body, headers: {}, companyId: '11111111-1111-4111-8111-111111111111',
    user: { id: '99999999-9999-4999-8999-999999999999' } } as unknown as NextApiRequest;
  const res = {
    statusCode: 0, sent: undefined as unknown, headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { this.headers[k] = v; return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.sent = payload; return this; },
    send(payload: unknown) { this.sent = payload; return this; },
    end() { return this; },
  };
  return Promise.resolve((handler as (q: NextApiRequest, s: NextApiResponse) => unknown)(req, res as unknown as NextApiResponse))
    .then(() => res);
}

const routes = [
  { name: 'supplier-credit-notes PATCH reverse', handler: supplierCreditNotes, method: 'PATCH',
    body: { id: ID, action: 'reverse' }, service: () => vi.mocked(cancelCreditNote), ordinary: 500 },
  { name: 'journal-entries-action reverse', handler: journalEntriesAction, method: 'POST',
    body: { id: ID, action: 'reverse' }, service: () => vi.mocked(reverseJournalEntry), ordinary: 400 },
  { name: 'soft-delete POST (invoice delete)', handler: softDeleteRoute, method: 'POST',
    body: { entityType: 'customer_invoice', entityId: ID }, service: () => vi.mocked(softDelete), ordinary: 500 },
  { name: 'soft-delete PUT (undo delete)', handler: softDeleteRoute, method: 'PUT',
    body: { entityType: 'customer_invoice', entityId: ID }, service: () => vi.mocked(undoDelete), ordinary: 500 },
  { name: 'bank-auto-post undo', handler: bankAutoPost, method: 'POST',
    body: { action: 'undo', runId: ID }, service: () => vi.mocked(undoRun), ordinary: 400 },
  { name: 'bank-auto-post undoAnyway', handler: bankAutoPost, method: 'POST',
    body: { action: 'undoAnyway', runId: ID, transactionId: ID2, offsetJournalId: ID3 }, service: () => vi.mocked(undoAnyway),
    ordinary: 500 },
] as const;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getCreditNoteById).mockResolvedValue({ id: ID, type: 'supplier' } as never);
});

describe.each(routes)('$name', ({ handler, method, body, service, ordinary }) => {
  it.each([
    ['the chain head', () => new JournalReversalLockTimeoutError(ID)],
    ['the flow budget', () => new RowLockTimeoutError(`Invoice ${ID}`)],
  ])('answers a lock timeout on %s 503 + Retry-After', async (_what, make) => {
    service().mockRejectedValue(make() as never);
    const res = await call(handler, method, body);
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('2');
    expect(JSON.stringify(res.sent)).toMatch(/retry in a moment/);
  });

  it(`still answers an ordinary failure ${ordinary}`, async () => {
    service().mockRejectedValue(new Error('Cannot do that') as never);
    expect((await call(handler, method, body)).statusCode).toBe(ordinary);
  });
});

// D11: K-071's 409 for a held bank line or payment (core/retryableContention) is now 503 + Retry-After, like every held row.
it('bank-auto-post undo answers a held bank line 503 + Retry-After', async () => {
  vi.mocked(undoRun).mockRejectedValue(new BankTransactionLockTimeoutError(ID) as never);
  const res = await call(bankAutoPost, 'POST', { action: 'undo', runId: ID });
  expect(res.statusCode).toBe(503);
  expect(res.headers['Retry-After']).toBe('2');
});
