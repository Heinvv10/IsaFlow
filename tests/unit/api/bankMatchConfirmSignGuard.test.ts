/**
 * POST /api/accounting/bank-match-confirm must refuse a match whose bank line
 * points the WRONG WAY, before it writes anything.
 *
 * ── WHY THIS ROUTE, AND WHY NOW ─────────────────────────────────────────────
 *
 * This is the FindMatchModal's confirm endpoint: a human picks a bill or an
 * invoice for a bank line and this route posts the journal AND settles the
 * document. It settles it with arithmetic of its own — `paymentAmount =
 * Math.abs(amount)`, then `amount_paid += min(paymentAmount, outstanding)` —
 * which has no idea which way the money went.
 *
 * That was survivable while `allocateTransaction` posted the payment direction
 * unconditionally: a money-IN line against a bill posted DR AP / CR Bank AND
 * reduced `amount_paid`, so the control account and the subledger were wrong
 * about the bank in the SAME direction and stayed equal to each other.
 *
 * Teaching `allocateTransaction` to respect the sign broke that accidental
 * symmetry and made this route worse than it was. The journal now posts
 * DR Bank / CR AP — correct, the refund raises the liability — while this
 * route still reduces `amount_paid`. AP control and AP subledger then differ
 * by TWICE the line, behind a match a human confirmed on screen. Getting the
 * GL right is not a licence to leave the subledger wrong.
 *
 * ── REFUSE, DO NOT APPLY ────────────────────────────────────────────────────
 *
 * The same answer the MCP tools give, for the same reason: settling a bill is
 * money OUT and settling a customer invoice is money IN, and there is no
 * refund-application concept for either to route the other into. `purchase_order`
 * is refused on the supplier rule too — it flips the PO to `paid` outright.
 *
 * ── AND IT MUST BE A PRE-WRITE 400 ──────────────────────────────────────────
 *
 * `withAuth` decides COMMIT vs ROLLBACK on `res.statusCode >= 500`, so a 4xx
 * COMMITS whatever was already written. The guard therefore has to run before
 * `allocateTransaction`, not inside the route's trailing catch — the same rule
 * receiptMatchConfirmPartialCommit.test.ts pins for its neighbour.
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
vi.mock('@/modules/accounting/services/bank/bankReconciliationService', () => ({
  allocateTransaction: vi.fn(),
  matchTransaction: vi.fn(),
}));

import { sql } from '@/lib/neon';
import {
  allocateTransaction,
  matchTransaction,
} from '@/modules/accounting/services/bank/bankReconciliationService';
import handler from '../../../pages/api/accounting/bank-match-confirm';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const BANK_TX = '66666666-6666-4666-8666-666666666666';
const CANDIDATE = '44444444-4444-4444-8444-444444444444';

type SqlMock = ReturnType<typeof vi.fn>;
const mockSql = sql as unknown as SqlMock;

function mockReqRes(body: Record<string, unknown>) {
  const req = {
    method: 'POST',
    query: {},
    body,
    companyId: COMPANY,
    user: { id: '99999999-9999-4999-8999-999999999999' },
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

/**
 * The route's read order: the bank line first, then the candidate document.
 * `mockResolvedValue` backstops every later statement so a branch that reads
 * further does not fall off the end of the queue.
 */
function withBankLine(amount: number, candidateRow: Record<string, unknown>) {
  mockSql
    .mockResolvedValueOnce([{ amount }])
    .mockResolvedValueOnce([candidateRow])
    .mockResolvedValue([]);
}

const BILL = {
  id: CANDIDATE, supplier_id: '22222222-2222-4222-8222-222222222222',
  total_amount: '1000.00', amount_paid: '0.00', balance: '1000.00',
};
const INVOICE = {
  id: CANDIDATE, customer_id: '22222222-2222-4222-8222-222222222222',
  total_amount: '1000.00', amount_paid: '0.00',
};
const PO = { id: CANDIDATE, supplier_id: '22222222-2222-4222-8222-222222222222', total: '1000.00' };

beforeEach(() => {
  // mockReset, NOT clearAllMocks: `clearAllMocks` clears CALLS but leaves the
  // `mockResolvedValueOnce` queue intact, so a test whose guard fires early
  // leaves its unread rows for the next test — which then reads a document row
  // as the bank line and sees a NaN amount. The three refusal cases each stop
  // one read short by design, so this suite guarantees that leak without it.
  vi.clearAllMocks();
  mockSql.mockReset();
});

describe('bank-match-confirm — a line pointing the wrong way is refused', () => {
  it.each([
    ['supplier_invoice', BILL, 120290, /money IN/i],
    ['purchase_order', PO, 120290, /money IN/i],
    ['customer_invoice', INVOICE, -500, /money OUT/i],
  ])('refuses %s when the bank line contradicts it', async (candidateType, row, amount, expected) => {
    withBankLine(amount, row);
    const { req, res } = mockReqRes({
      bankTransactionId: BANK_TX, candidateType, candidateId: CANDIDATE,
    });
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.sent)).toMatch(expected);
    // The whole point: nothing was written, so the 400 that COMMITs cannot
    // commit a journal or a settled document.
    expect(allocateTransaction).not.toHaveBeenCalled();
    // Two reads and no more — the guard fires before the UPDATE.
    const writes = mockSql.mock.calls.filter(
      (c) => /UPDATE|INSERT/.test((c[0] as unknown as TemplateStringsArray).join('')),
    );
    expect(writes).toHaveLength(0);
  });

  it.each([
    ['supplier_invoice', BILL, -1000],
    ['purchase_order', PO, -1000],
    ['customer_invoice', INVOICE, 1000],
  ])('still confirms %s when the direction agrees', async (candidateType, row, amount) => {
    withBankLine(amount, row);
    const { req, res } = mockReqRes({
      bankTransactionId: BANK_TX, candidateType, candidateId: CANDIDATE,
    });
    await handler(req, res);

    expect(res.statusCode).not.toBe(400);
    expect(allocateTransaction).toHaveBeenCalledTimes(1);
  });

  // These two settle no document — they tie a bank line to a journal that
  // already exists — so there is no direction to contradict and the guard must
  // not reach them.
  it('leaves journal_line matching alone', async () => {
    mockSql.mockResolvedValueOnce([{ amount: 120290 }]).mockResolvedValue([]);
    const { req, res } = mockReqRes({
      bankTransactionId: BANK_TX, candidateType: 'journal_line', candidateId: CANDIDATE,
    });
    await handler(req, res);
    expect(res.statusCode).not.toBe(400);
    expect(matchTransaction).toHaveBeenCalledTimes(1);
  });
});
