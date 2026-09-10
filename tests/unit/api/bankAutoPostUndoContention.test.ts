/**
 * K-071 r15 — `POST /api/accounting/bank-auto-post` (undo) answers contention
 * 409, and every other failure keeps its 400.
 *
 * `undoRun` → `reverseReconciledTransaction` → `lockBankTransactionForUpdate`
 * is the route's only contention raiser (scripted reverse call graph, fix.md).
 * The service swallowed the typed error on an aborted transaction, so the next
 * statement raised 25P02 and this route answered 400 "Undo failed" — the retry
 * wording gone. The service now skips a contended row under its own savepoint
 * and re-throws only when no row was written; this pins the route's half.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/auth', () => ({
  withAuth: (h: unknown) => h,
  withWriteAccess: (h: unknown) => h,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/autoPostGateService', () => ({
  getAutoPostSettings: vi.fn(),
  updateAutoPostSettings: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/autoPostUndoService', () => ({
  undoRun: vi.fn(),
}));

import { undoRun } from '@/modules/accounting/services/bank/autoPostUndoService';
import { BankTransactionLockTimeoutError } from '@/modules/accounting/services/bank/bankTxLock';
import handler from '../../../pages/api/accounting/bank-auto-post';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const USER = '99999999-9999-4999-8999-999999999999';
const RUN = '55555555-5555-4555-8555-555555555555';

function mockReqRes() {
  const req = {
    method: 'POST', query: {}, body: { action: 'undo', runId: RUN },
    companyId: COMPANY, user: { id: USER },
  } as unknown as NextApiRequest;
  const res = {
    statusCode: 0,
    sent: undefined as unknown,
    setHeader() { return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.sent = payload; return this; },
    send(payload: unknown) { this.sent = payload; return this; },
    end() { return this; },
  };
  return { req, res: res as unknown as NextApiResponse & typeof res };
}

beforeEach(() => { vi.resetAllMocks(); });

describe('POST /api/accounting/bank-auto-post (undo)', () => {
  it('answers a contended bank line 409 with the retry wording', async () => {
    vi.mocked(undoRun).mockRejectedValue(new BankTransactionLockTimeoutError('tx-1'));
    const { req, res } = mockReqRes();
    await (handler as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(req, res);

    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.sent)).toMatch(/retry in a moment/i);
  });

  // K-071 r19: once a row is reversed the counts are the answer — a 4xx here
  // would COMMIT that reversal under a failure status.
  it('answers a partly-undone run 200 with the counts', async () => {
    vi.mocked(undoRun).mockResolvedValue({ reversed: 1, skipped: 1, alreadyUndone: 0, undone: false });
    const { req, res } = mockReqRes();
    await (handler as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(req, res);

    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.sent)).toContain('"undone":false');
    expect(JSON.stringify(res.sent)).toContain('"skipped":1');
  });

  it('keeps 400 for a failure that is not contention', async () => {
    vi.mocked(undoRun).mockRejectedValue(new Error('Run already undone'));
    const { req, res } = mockReqRes();
    await (handler as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(req, res);

    expect(res.statusCode).toBe(400);
  });
});
