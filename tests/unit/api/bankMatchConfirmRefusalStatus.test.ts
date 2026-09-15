/**
 * POST /api/accounting/bank-match-confirm — which status code the trailing
 * catch is allowed to answer, and why the answer is not always 500.
 *
 * The rule this route lives under is `withAuth`'s: it decides COMMIT vs
 * ROLLBACK on `statusCode >= 500`, so a 4xx raised AFTER a write commits that
 * write. That is why the catch answers 500 by default — everything reachable
 * from inside `allocateTransaction` past its first statement has already posted
 * a journal and touched `bank_transactions`.
 *
 * But `allocateTransaction`'s FIRST statement is `lockBankTransactionForUpdate`,
 * and the three throws decided from that locked row happen before any write at
 * all. Answering those 500 made an ordinary UI double-click a hard failure with
 * no remedy in it — `apiResponse.internalError` replaces the message with "An
 * internal error occurred" outside development — and turned every contention
 * event into a monitored server fault.
 *
 * So: a lock timeout is 409 (retryable, nothing acquired), a
 * `BankAllocationRefusal` is 400 (decided from the row, nothing written), and
 * everything else keeps its 500. This suite pins all three, and pins that the
 * 4xx branches really did write nothing.
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
// The customer arm now takes the bank line's row lock FIRST — the canonical
// order (`bank/.claude.md`) — and `lockBankTransactionForUpdate` refuses to run
// outside a request transaction. Stand in for the withAuth-bound client.
const { mockTx } = vi.hoisted(() => ({
  mockTx: { client: { query: () => Promise.resolve(undefined) } },
}));
vi.mock('@/lib/als', async () => {
  const actual = await vi.importActual<typeof import('@/lib/als')>('@/lib/als');
  return { ...actual, als: { ...actual.als, getStore: () => ({ client: mockTx.client }) } };
});
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/bankReconciliationService', () => ({
  allocateTransaction: vi.fn(),
  matchTransaction: vi.fn(),
}));
// The customer arm settles through the AR service now (it used to post and
// UPDATE inline), so that is where a throw enters the route's catch from.
vi.mock('@/modules/accounting/services/ar/receiptMatchConfirmService', () => ({
  validateBankReceiptApplication: vi.fn(async () => ({})),
  confirmReceiptMatch: vi.fn(async () => ({ customerPaymentId: 'cp-1', allocatedTotal: 1000 })),
}));

import { sql } from '@/lib/neon';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankReconciliationService';
import { confirmReceiptMatch } from '@/modules/accounting/services/ar/receiptMatchConfirmService';
import { BankTransactionLockTimeoutError } from '@/modules/accounting/services/bank/bankTxLock';
import { BankAllocationRefusal } from '@/modules/accounting/services/bank/bankAllocationRefusal';
import { ReceiptRefusal } from '@/modules/accounting/services/ar/receiptRefusal';
import { validateBankReceiptApplication } from '@/modules/accounting/services/ar/receiptMatchConfirmService';
import handler from '../../../pages/api/accounting/bank-match-confirm';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const BANK_TX = '66666666-6666-4666-8666-666666666666';
const CANDIDATE = '44444444-4444-4444-8444-444444444444';

type SqlMock = ReturnType<typeof vi.fn>;
const mockSql = sql as unknown as SqlMock;
const allocate = allocateTransaction as unknown as ReturnType<typeof vi.fn>;
const confirmReceipt = confirmReceiptMatch as unknown as ReturnType<typeof vi.fn>;
const validateReceipt = validateBankReceiptApplication as unknown as ReturnType<typeof vi.fn>;

/** A money-OUT line against a purchase order: the direction agrees, so the
 *  route reaches `allocateTransaction` DIRECTLY and the catch is what decides.
 *  The two invoice arms reach it through their settlement services instead —
 *  the customer one is exercised on its own below. */
const PO = { id: CANDIDATE, supplier_id: '22222222-2222-4222-8222-222222222222', total: '1000.00' };

/** A money-IN line against a customer invoice, for the arm that goes through AR. */
const INVOICE = {
  id: CANDIDATE, customer_id: '22222222-2222-4222-8222-222222222222',
  total_amount: '1000.00', amount_paid: '0.00',
};

function mockReqRes(candidateType = 'purchase_order') {
  const req = {
    method: 'POST',
    query: {},
    body: { bankTransactionId: BANK_TX, candidateType, candidateId: CANDIDATE },
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
 * Writes the route issued itself. The 4xx branches must have issued none.
 *
 * Anchored on the WRITE forms rather than a bare /UPDATE/: since the confirm
 * arms take the bank line's row lock first, `FOR UPDATE` appears on a statement
 * that reads and writes nothing, and a bare match counted it as a write. The
 * optional alias group covers `UPDATE customer_invoices ci SET …`, an idiom in
 * use in this repo and otherwise invisible here.
 */
const WRITE_SQL = /INSERT INTO|UPDATE\s+\w+(\s+(?:AS\s+)?\w+)?\s+SET|DELETE FROM/;
function writeCount(): number {
  return mockSql.mock.calls.filter(
    (c) => WRITE_SQL.test((c[0] as unknown as TemplateStringsArray).join('')),
  ).length;
}

beforeEach(() => {
  // mockReset, not clearAllMocks: an unread `mockResolvedValueOnce` leaks into
  // the next test and is read there as the bank line.
  vi.clearAllMocks();
  mockSql.mockReset();
  allocate.mockReset();
  confirmReceipt.mockReset();
  validateReceipt.mockReset();
  validateReceipt.mockResolvedValue({});
  mockSql.mockResolvedValueOnce([{ amount: -1000 }]).mockResolvedValueOnce([PO]).mockResolvedValue([]);
});

describe('bank-match-confirm — the status code the trailing catch answers', () => {
  it('answers 409 with the retry wording when the line is held by another request', async () => {
    allocate.mockRejectedValueOnce(new BankTransactionLockTimeoutError(BANK_TX));
    const { req, res } = mockReqRes();
    await handler(req, res);

    expect(res.statusCode).toBe(409);
    // The wording `bankTxLock` documents as load-bearing has to survive to the
    // client: `internalError` would have replaced it in production.
    expect(JSON.stringify(res.sent)).toMatch(/retry/i);
    expect(JSON.stringify(res.sent)).not.toMatch(/An internal error occurred/);
    expect(writeCount()).toBe(0);
  });

  it('answers 400 with its own remedy when the locked row refuses the allocation', async () => {
    allocate.mockRejectedValueOnce(
      new BankAllocationRefusal('Transaction already allocated — cannot allocate'),
    );
    const { req, res } = mockReqRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.sent)).toMatch(/already allocated/);
    expect(writeCount()).toBe(0);
  });

  it('still answers 500 for a throw that could have happened after the first write', async () => {
    allocate.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    const { req, res } = mockReqRes();
    await handler(req, res);

    // 500 is what makes `withAuth` ROLLBACK. A 400 here would COMMIT the
    // half-finished match.
    expect(res.statusCode).toBe(500);
  });

  // The customer arm reaches `allocateTransaction` through `confirmReceiptMatch`
  // rather than calling it itself, so its refusals have to travel two frames
  // further before the catch sees them. Same answer, or the arm that now settles
  // correctly would answer a contended line with a bare 500.
  it('answers 409 for a contended line raised through the customer settlement service', async () => {
    mockSql.mockReset();
    mockSql.mockResolvedValueOnce([{ amount: 1000 }])
      // The arm's `FOR UPDATE` on the bank line, before the invoice read.
      .mockResolvedValueOnce([{ id: BANK_TX, status: 'imported' }])
      .mockResolvedValueOnce([INVOICE]).mockResolvedValue([]);
    confirmReceipt.mockRejectedValueOnce(new BankTransactionLockTimeoutError(BANK_TX));

    const { req, res } = mockReqRes('customer_invoice');
    await handler(req, res);

    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.sent)).toMatch(/retry/i);
    expect(writeCount()).toBe(0);
  });

  // MEDIUM-2 (round 9). Contention on the INVOICE is the same event as
  // contention on the LINE and gets the same answer. It did not: the invoice
  // lock's timeout is raised as a `ReceiptRefusal` — the class every refusal
  // ABOUT THE BOOKS also uses — so the arm reported `kind:'refused'` and the
  // route answered 400. On one screen, at one instant, 409 if the peer held the
  // line and 400 if it held the invoice; and 400 is what this route reserves
  // for the user's own mistake and monitors as such.
  it('answers 409, not 400, when the peer holds the INVOICE rather than the line', async () => {
    mockSql.mockReset();
    mockSql.mockResolvedValueOnce([{ amount: 1000 }])
      .mockResolvedValueOnce([{ id: BANK_TX, status: 'imported' }])
      .mockResolvedValueOnce([INVOICE]).mockResolvedValue([]);
    validateReceipt.mockRejectedValueOnce(new ReceiptRefusal(
      'Another request is applying cash to one of these invoices — retry in a moment.',
      { retryable: true },
    ));

    const { req, res } = mockReqRes('customer_invoice');
    await handler(req, res);

    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.sent)).toMatch(/retry in a moment/i);
    expect(writeCount()).toBe(0);
  });

  // The mirror, and the reason `retryable` is a flag rather than a new class:
  // a refusal ABOUT THE BOOKS keeps its 400, because retrying it unchanged
  // repeats it.
  it('keeps 400 for a books refusal from the same class', async () => {
    mockSql.mockReset();
    mockSql.mockResolvedValueOnce([{ amount: 1000 }])
      .mockResolvedValueOnce([{ id: BANK_TX, status: 'imported' }])
      .mockResolvedValueOnce([INVOICE]).mockResolvedValue([]);
    validateReceipt.mockRejectedValueOnce(
      new ReceiptRefusal('Invoice INV-9 is cancelled.'),
    );

    const { req, res } = mockReqRes('customer_invoice');
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.sent)).toMatch(/cancelled/);
    expect(writeCount()).toBe(0);
  });

  // The classification is on the error's `code`, not on `instanceof`: module
  // mocking and a bundler's second copy of a module both defeat prototype
  // identity, and a refusal misread as a fault answers 500 with no remedy.
  it('classifies a structurally identical error from another module realm', async () => {
    allocate.mockRejectedValueOnce(
      Object.assign(new Error('a foreign copy of the refusal'), { code: 'BANK_ALLOCATION_REFUSED' }),
    );
    const { req, res } = mockReqRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });
});
