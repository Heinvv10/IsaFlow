/**
 * D11: a request that waits on a row another transaction holds answers 503 + Retry-After, not 409. These are the bank
 * and settlement routes (`bank-transactions-action` every verb, `-manual`, `bank-auto-post` undo / undoAnyway,
 * `bank-match-confirm` both arms and the catch, `supplier-allocations`, `customer-allocations`). A held row is a typed
 * lock timeout, or a `retryable` refusal flagged `held`; a retryable refusal that is NOT held is a STATE conflict and
 * keeps its 409. The D8 flows (reverse, void) are pinned in d8LockTimeoutRoutes.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: (_n: string, fn: () => unknown) => fn() }));
vi.mock('@/modules/accounting/services/bank/bankReconciliationService', () => ({
  matchTransaction: vi.fn(), unmatchTransaction: vi.fn(), excludeTransaction: vi.fn(), autoMatchTransactions: vi.fn(),
  allocateTransaction: vi.fn(), splitAllocateTransaction: vi.fn(), deleteTransactions: vi.fn(),
  bulkAcceptTransactions: vi.fn(), reverseReconciledTransaction: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/autoPostUndoService', () => ({ undoRun: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/autoPostGateService', () => ({
  getAutoPostSettings: vi.fn(), updateAutoPostSettings: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/autoPostHandCorrection', () => ({
  HandCorrectionRefusedError: class extends Error {}, markCorrectedByHand: vi.fn(), undoAnyway: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/confirmSupplierMatch', () => ({ confirmSupplierInvoiceMatch: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/confirmCustomerMatch', () => ({ confirmCustomerInvoiceMatch: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/supplierPaymentApplicationService', () => ({
  planSupplierPaymentApplication: vi.fn(), applySupplierPaymentPlan: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/receiptApplicationService', () => ({
  planReceiptApplication: vi.fn(), applyReceiptPlan: vi.fn(),
}));

import { sql } from '@/lib/neon';
import {
  allocateTransaction, matchTransaction, unmatchTransaction, excludeTransaction, splitAllocateTransaction, autoMatchTransactions,
} from '@/modules/accounting/services/bank/bankReconciliationService';
import { BankMatchTargetError } from '@/modules/accounting/services/bank/bankTxStatusMutations';
import { undoRun } from '@/modules/accounting/services/bank/autoPostUndoService';
import { undoAnyway } from '@/modules/accounting/services/bank/autoPostHandCorrection';
import { confirmSupplierInvoiceMatch } from '@/modules/accounting/services/bank/confirmSupplierMatch';
import { confirmCustomerInvoiceMatch } from '@/modules/accounting/services/bank/confirmCustomerMatch';
import { planSupplierPaymentApplication } from '@/modules/accounting/services/ap/supplierPaymentApplicationService';
import { planReceiptApplication } from '@/modules/accounting/services/ar/receiptApplicationService';
import { BankTransactionLockTimeoutError } from '@/modules/accounting/services/bank/bankTxLock';
import { PaymentLockTimeoutError } from '@/modules/accounting/services/core/paymentLock';
import { ReceiptRefusal } from '@/modules/accounting/services/ar/receiptRefusal';
import { SupplierPaymentRefusal } from '@/modules/accounting/services/ap/supplierPaymentRefusal';
import bankAction from '../../../pages/api/accounting/bank-transactions-action';
import bankManual from '../../../pages/api/accounting/bank-transactions-manual';
import bankAutoPost from '../../../pages/api/accounting/bank-auto-post';
import bankMatchConfirm from '../../../pages/api/accounting/bank-match-confirm';
import supplierAllocations from '../../../pages/api/accounting/supplier-allocations';
import customerAllocations from '../../../pages/api/accounting/customer-allocations';

const ID = '66666666-6666-4666-8666-666666666666';
const ID2 = '77777777-7777-4777-8777-777777777777';
type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;

function call(handler: Handler, body: unknown, method = 'POST') {
  const req = { method, query: {}, body, companyId: '11111111-1111-4111-8111-111111111111',
    user: { id: '99999999-9999-4999-8999-999999999999' } } as unknown as NextApiRequest;
  const res = {
    statusCode: 0, sent: undefined as unknown, headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { this.headers[k] = v; return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.sent = payload; return this; },
    send(payload: unknown) { this.sent = payload; return this; },
    end() { return this; },
  };
  return Promise.resolve(handler(req, res as unknown as NextApiResponse)).then(() => res);
}

const bankLine = () => new BankTransactionLockTimeoutError();
const payment = () => new PaymentLockTimeoutError();
const heldBill = () => new SupplierPaymentRefusal('Another request is paying one of these bills — retry in a moment.',
  { retryable: true, held: true });
const heldInvoice = () => new ReceiptRefusal('Another request is applying cash to one of these invoices — retry in a moment.',
  { retryable: true, held: true });
const stateRefusal = () => new ReceiptRefusal('This document changed while it was being reversed — retry in a moment.',
  { retryable: true });

function expectHeld(res: Awaited<ReturnType<typeof call>>) {
  expect(res.statusCode).toBe(503);
  expect(res.headers['Retry-After']).toBe('2');
}

beforeEach(() => { vi.clearAllMocks(); });

describe('D11 bank-transactions-action: every verb answers a held row 503', () => {
  const verbs: Array<[string, Record<string, unknown>, ReturnType<typeof vi.fn>]> = [
    ['match', { action: 'match', bankTransactionId: ID, journalLineId: ID2 }, vi.mocked(matchTransaction)],
    ['unmatch', { action: 'unmatch', bankTransactionId: ID }, vi.mocked(unmatchTransaction)],
    ['exclude', { action: 'exclude', bankTransactionId: ID }, vi.mocked(excludeTransaction)],
    ['allocate', { action: 'allocate', bankTransactionId: ID, contraAccountId: ID2 }, vi.mocked(allocateTransaction)],
    ['split_allocate', { action: 'split_allocate', bankTransactionId: ID, lines: [{ contraAccountId: ID2, amount: 1 }] },
      vi.mocked(splitAllocateTransaction)],
  ];
  for (const [verb, body, fn] of verbs) {
    for (const [what, make] of [['bank line', bankLine], ['payment', payment], ['bill', heldBill], ['invoice', heldInvoice]] as const) {
      it(`${verb}: a held ${what} -> 503 + Retry-After`, async () => {
        fn.mockRejectedValueOnce(make());
        expectHeld(await call(bankAction, body));
      });
    }
    it(`${verb}: a retryable STATE conflict stays 409`, async () => {
      fn.mockRejectedValueOnce(stateRefusal());
      const res = await call(bankAction, body);
      expect(res.statusCode).toBe(409);
      expect(res.headers['Retry-After']).toBeUndefined();
    });
  }
});

describe('D11 bank-transactions-manual', () => {
  const body = { type: 'spend', bankAccountId: ID, date: '2026-09-01', amount: 10, allocationType: 'account', contraAccountId: ID2 };
  beforeEach(() => { vi.mocked(sql).mockResolvedValue([{ id: ID }] as never); });
  it('a held bank line -> 503 + Retry-After', async () => {
    vi.mocked(allocateTransaction).mockRejectedValueOnce(bankLine());
    expectHeld(await call(bankManual, body));
  });
  it('a held bill -> 503 + Retry-After', async () => {
    vi.mocked(allocateTransaction).mockRejectedValueOnce(heldBill());
    expectHeld(await call(bankManual, body));
  });
  it('a retryable state conflict stays 409', async () => {
    vi.mocked(allocateTransaction).mockRejectedValueOnce(stateRefusal());
    expect((await call(bankManual, body)).statusCode).toBe(409);
  });
});

describe('D11 bank-auto-post', () => {
  const undo = { action: 'undo', runId: ID };
  const hand = { action: 'undoAnyway', runId: ID, transactionId: ID2, offsetJournalId: ID2 };
  it('undo: a held bank line -> 503 + Retry-After', async () => {
    vi.mocked(undoRun).mockRejectedValueOnce(bankLine());
    expectHeld(await call(bankAutoPost, undo));
  });
  it('undo: a retryable state conflict stays 409', async () => {
    vi.mocked(undoRun).mockRejectedValueOnce(stateRefusal());
    expect((await call(bankAutoPost, undo)).statusCode).toBe(409);
  });
  it('undoAnyway: a held payment -> 503 + Retry-After', async () => {
    vi.mocked(undoAnyway).mockRejectedValueOnce(payment());
    expectHeld(await call(bankAutoPost, hand));
  });
  it('undoAnyway: a retryable state conflict stays 409', async () => {
    vi.mocked(undoAnyway).mockRejectedValueOnce(stateRefusal());
    expect((await call(bankAutoPost, hand)).statusCode).toBe(409);
  });
});

describe('D11 bank-match-confirm', () => {
  const arm = (candidateType: string) => ({ bankTransactionId: ID, candidateType, candidateId: ID2 });
  beforeEach(() => { vi.mocked(sql).mockResolvedValue([{ amount: '-100' }] as never); });
  it('supplier arm contended -> 503 + Retry-After', async () => {
    vi.mocked(confirmSupplierInvoiceMatch).mockResolvedValueOnce({ ok: false, kind: 'contended', message: 'held — retry' });
    expectHeld(await call(bankMatchConfirm, arm('supplier_invoice')));
  });
  it('customer arm contended -> 503 + Retry-After', async () => {
    vi.mocked(sql).mockResolvedValue([{ amount: '100' }] as never);
    vi.mocked(confirmCustomerInvoiceMatch).mockResolvedValueOnce({ ok: false, kind: 'contended', message: 'held — retry' });
    expectHeld(await call(bankMatchConfirm, arm('customer_invoice')));
  });
  it('supplier arm retryable state conflict -> 409, no Retry-After', async () => {
    vi.mocked(confirmSupplierInvoiceMatch).mockResolvedValueOnce({ ok: false, kind: 'conflict', message: 'changed' });
    const r = await call(bankMatchConfirm, arm('supplier_invoice'));
    expect(r.statusCode).toBe(409); expect(r.headers['Retry-After']).toBeUndefined();
  });
  it('customer arm retryable state conflict -> 409, no Retry-After', async () => {
    vi.mocked(sql).mockResolvedValue([{ amount: '100' }] as never);
    vi.mocked(confirmCustomerInvoiceMatch).mockResolvedValueOnce({ ok: false, kind: 'conflict', message: 'changed' });
    const r = await call(bankMatchConfirm, arm('customer_invoice'));
    expect(r.statusCode).toBe(409); expect(r.headers['Retry-After']).toBeUndefined();
  });
  it('supplier arm refused stays 400', async () => {
    vi.mocked(confirmSupplierInvoiceMatch).mockResolvedValueOnce({ ok: false, kind: 'refused', message: 'cancelled' });
    expect((await call(bankMatchConfirm, arm('supplier_invoice'))).statusCode).toBe(400);
  });
  it('a held bank line thrown from the journal_line arm -> 503 + Retry-After', async () => {
    vi.mocked(matchTransaction).mockRejectedValueOnce(bankLine());
    expectHeld(await call(bankMatchConfirm, arm('journal_line')));
  });
  it('a retryable state conflict thrown from the catch stays 409', async () => {
    vi.mocked(matchTransaction).mockRejectedValueOnce(stateRefusal());
    expect((await call(bankMatchConfirm, arm('journal_line'))).statusCode).toBe(409);
  });
});

describe('D11 supplier-allocations / customer-allocations', () => {
  const sBody = { paymentId: ID, allocations: [{ invoiceId: ID2, amount: 10 }] };
  const cBody = { paymentId: ID, allocations: [{ invoiceId: ID2, amount: 10 }] };
  it('supplier: a held payment -> 503 + Retry-After', async () => {
    vi.mocked(planSupplierPaymentApplication).mockRejectedValueOnce(payment());
    expectHeld(await call(supplierAllocations, sBody));
  });
  it('supplier: a held bill -> 503 + Retry-After', async () => {
    vi.mocked(planSupplierPaymentApplication).mockRejectedValueOnce(heldBill());
    expectHeld(await call(supplierAllocations, sBody));
  });
  it('supplier: a retryable state conflict stays 409', async () => {
    vi.mocked(planSupplierPaymentApplication).mockRejectedValueOnce(
      new SupplierPaymentRefusal('changed — retry in a moment.', { retryable: true }));
    expect((await call(supplierAllocations, sBody)).statusCode).toBe(409);
  });
  it('customer: a held payment -> 503 + Retry-After', async () => {
    vi.mocked(planReceiptApplication).mockRejectedValueOnce(payment());
    expectHeld(await call(customerAllocations, cBody));
  });
  it('customer: a held invoice -> 503 + Retry-After', async () => {
    vi.mocked(planReceiptApplication).mockRejectedValueOnce(heldInvoice());
    expectHeld(await call(customerAllocations, cBody));
  });
  it('customer: a retryable state conflict stays 409', async () => {
    vi.mocked(planReceiptApplication).mockRejectedValueOnce(stateRefusal());
    expect((await call(customerAllocations, cBody)).statusCode).toBe(409);
  });
});

describe('D11 round 7: auto_match run-level failures', () => {
  const body = { action: 'auto_match', bankAccountId: ID };
  it('an unexpected (untyped) error is rethrown for withErrorHandler (500, rollback), never a 400 that commits', async () => {
    vi.mocked(autoMatchTransactions).mockRejectedValueOnce(new Error('FK violation'));
    await expect(call(bankAction, body)).rejects.toThrow('FK violation');
  });
  it('a cancelled session (RECONCILIATION_NOT_FOUND) -> 404', async () => {
    vi.mocked(autoMatchTransactions).mockRejectedValueOnce(new BankMatchTargetError('RECONCILIATION_NOT_FOUND', 'gone'));
    expect((await call(bankAction, { ...body, reconciliationId: ID2 })).statusCode).toBe(404);
  });
  it('a held row is still 503', async () => {
    vi.mocked(autoMatchTransactions).mockRejectedValueOnce(bankLine());
    expectHeld(await call(bankAction, body));
  });
});
