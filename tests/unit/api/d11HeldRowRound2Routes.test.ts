/**
 * D11 round 2 (blind review, LOW): unit route tests for the held-row answers that were only integration-pinned, and
 * mutation guards for the `busy` arms. A fingerprint / row a peer holds -> 503 + Retry-After; the state answer on the
 * same route is unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/als', () => ({ als: { getStore: vi.fn() }, assertTxUsable: vi.fn() }));
vi.mock('@/modules/accounting/services/items/farDepreciationService', () => ({ checkCapitalizationThreshold: vi.fn() }));
vi.mock('@/modules/accounting/services/expense/expenseClaimService', async (orig) => ({ ...(await orig<object>()), addLine: vi.fn() }));
vi.mock('@/modules/accounting/services/capture/captureRowLock', async (orig) => ({
  ...(await orig<object>()), lockCapturedDocumentForUpdate: vi.fn(),
}));
vi.mock('@/modules/accounting/services/capture/receiptDuplicateGuard', () => ({ checkReceiptDuplicate: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/receiptToJournalService', async (orig) => ({
  ...(await orig<object>()),
  validateReceiptExtraction: vi.fn().mockReturnValue({ valid: true, errors: [] }),
  mapMerchantToExpenseAccount: vi.fn().mockReturnValue(null),
  buildExpenseJournalFromReceipt: vi.fn().mockReturnValue({ lines: [], description: 'd', entryDate: '2026-09-01' }),
  parseReceiptType: vi.fn(),
  shouldAutoPostReceipt: vi.fn().mockReturnValue(false),
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({ getSystemAccountId: vi.fn().mockResolvedValue('a') }));
vi.mock('@/modules/accounting/services/gl/inputVatDenial', async (orig) => ({
  ...(await orig<object>()), resolveVatCodeForAccount: vi.fn().mockResolvedValue({ denied: false }),
}));
vi.mock('@/modules/accounting/utils/doubleEntry', () => ({ validateJournalEntry: vi.fn().mockReturnValue({ valid: true, errors: [] }) }));
vi.mock('@/modules/accounting/services/gl/journalVatLockGuard', async (orig) => ({
  ...(await orig<object>()), assertJournalVatPeriodOpen: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { als } from '@/lib/als';
import { addLine } from '@/modules/accounting/services/expense/expenseClaimService';
import { lockCapturedDocumentForUpdate } from '@/modules/accounting/services/capture/captureRowLock';
import { checkReceiptDuplicate } from '@/modules/accounting/services/capture/receiptDuplicateGuard';
import { ClaimSourceDocumentError } from '@/modules/accounting/services/expense/claimSourceDocuments';
import { respondReceiptDuplicate } from '@/modules/accounting/services/capture/capturePostingClaim';
import receiptToJournal from '../../../pages/api/accounting/receipt-to-journal';
import expenseClaimById from '../../../pages/api/accounting/expense-claims/[id]/index';
import belowThreshold from '../../../pages/api/accounting/assets/below-threshold';

const ID = '66666666-6666-4666-8666-666666666666';
type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;
const makeRes = () => ({
  statusCode: 0, sent: undefined as unknown, headers: {} as Record<string, string>,
  setHeader(k: string, v: string) { this.headers[k] = v; return this; },
  status(c: number) { this.statusCode = c; return this; },
  json(p: unknown) { this.sent = p; return this; }, send(p: unknown) { this.sent = p; return this; }, end() { return this; },
});
function call(handler: Handler, method: string, body: unknown, query: Record<string, string> = {}) {
  const req = { method, query, body, companyId: 'c', user: { id: 'u' } } as unknown as NextApiRequest;
  const res = makeRes();
  return Promise.resolve(handler(req, res as unknown as NextApiResponse)).then(() => res);
}
const held = (r: ReturnType<typeof makeRes>) => { expect(r.statusCode, JSON.stringify(r.sent)).toBe(503); expect(r.headers['Retry-After']).toBe('2'); };
const dup = (kind: 'duplicate' | 'busy') => ({ kind, message: 'm', details: { code: 'X' } });

beforeEach(() => { vi.clearAllMocks(); });

describe('respondReceiptDuplicate (post-expense and receipt-to-journal)', () => {
  it("'busy' -> 503 + Retry-After", () => {
    const r = makeRes(); respondReceiptDuplicate(r as unknown as NextApiResponse, dup('busy')); held(r);
  });
  it("a real 'duplicate' keeps 409", () => {
    const r = makeRes(); respondReceiptDuplicate(r as unknown as NextApiResponse, dup('duplicate'));
    expect(r.statusCode).toBe(409); expect(r.headers['Retry-After']).toBeUndefined();
  });
});

describe('receipt-to-journal route', () => {
  beforeEach(() => {
    vi.mocked(lockCapturedDocumentForUpdate).mockResolvedValue({ extracted_data: { vendorName: 'v' }, status: 'pending' } as never);
    vi.mocked(sql).mockResolvedValue([] as never);
  });
  it('a fingerprint a peer holds (duplicate guard busy) -> 503 + Retry-After', async () => {
    vi.mocked(checkReceiptDuplicate).mockResolvedValueOnce(dup('busy') as never);
    held(await call(receiptToJournal, 'POST', { documentId: ID }));
  });
  it('a real duplicate keeps 409', async () => {
    vi.mocked(checkReceiptDuplicate).mockResolvedValueOnce(dup('duplicate') as never);
    const r = await call(receiptToJournal, 'POST', { documentId: ID });
    expect(r.statusCode).toBe(409); expect(r.headers['Retry-After']).toBeUndefined();
  });
});

describe('expense-claims/[id] (add line)', () => {
  const body = { lineDate: '2026-09-01', amount: 1 };
  it("a fingerprint a peer holds ('busy') -> 503 + Retry-After", async () => {
    vi.mocked(addLine).mockRejectedValueOnce(new ClaimSourceDocumentError('busy', ID));
    held(await call(expenseClaimById, 'POST', body, { id: ID }));
  });
  it('an already-posted source keeps 400', async () => {
    vi.mocked(addLine).mockRejectedValueOnce(new ClaimSourceDocumentError('already_posted', ID));
    const r = await call(expenseClaimById, 'POST', body, { id: ID });
    expect(r.statusCode).toBe(400); expect(r.headers['Retry-After']).toBeUndefined();
  });
});

describe('assets/below-threshold POST', () => {
  const client = { query: vi.fn().mockResolvedValue({}) };
  beforeEach(() => { vi.mocked(als.getStore).mockReturnValue({ client } as never); });
  it('a held asset row (55P03) -> 503 + Retry-After', async () => {
    vi.mocked(sql).mockRejectedValueOnce(Object.assign(new Error('lock timeout'), { code: '55P03' }));
    held(await call(belowThreshold, 'POST', { assetId: ID }));
  });
  it('an unknown asset keeps 404', async () => {
    vi.mocked(sql).mockResolvedValueOnce([] as never);
    const r = await call(belowThreshold, 'POST', { assetId: ID });
    expect(r.statusCode).toBe(404); expect(r.headers['Retry-After']).toBeUndefined();
  });
});
