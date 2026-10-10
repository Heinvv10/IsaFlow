/**
 * Unit tests for the POST action guards on
 * /api/accounting/customer-invoices-detail.
 *
 * Covers:
 *  - approve is rejected (400) for an invoice not in {draft, pending_approval}
 *    (e.g. cancelled) — prevents re-adding it to AR against a reversed journal
 *  - approve on a missing invoice → 404
 *  - approve from draft still succeeds and posts GL
 *  - cancel maps ClosedFiscalPeriodError from the reversal to a 400, not a 500
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// R-032 L5: the Login-as guard runs its own query first; it is covered by
// tests/unit/auth/impersonationGuard.test.ts and the r-032 integration suites.
// FX PR0: the currency gate reads the company row; it has its own tests (fx-pr0-*).
vi.mock('@/modules/accounting/services/shared/documentCurrency', async (importOriginal) =>
  (await import('../helpers/documentCurrencyMock')).documentCurrencyMock(await importOriginal()));
vi.mock('@/lib/auth/impersonationGuard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/impersonationGuard')>()),
  assertNotImpersonating: async () => undefined,
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({
  withAuth: (fn: unknown) => fn,
  withWriteAccess: (fn: unknown) => fn,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn((_res: unknown, data: unknown) => ({ kind: 'success', data })),
    badRequest: vi.fn((_res: unknown, error: string) => ({ kind: 'badRequest', error })),
    notFound: vi.fn((_res: unknown, entity: string, id: string) => ({ kind: 'notFound', entity, id })),
    validationError: vi.fn((_res: unknown, errors: unknown) => ({ kind: 'validationError', errors })),
    methodNotAllowed: vi.fn(() => ({ kind: 'methodNotAllowed' })),
    internalError: vi.fn(() => ({ kind: 'internalError' })),
    conflict: vi.fn((_res: unknown, error: string, details: unknown) => ({ kind: 'conflict', error, details })),
  },
  ErrorCode: {},
}));

const { sqlMock, cancelMock, postGlMock, snapshotMock } = vi.hoisted(() => ({
  sqlMock: Object.assign(vi.fn(), { transaction: vi.fn() }),
  cancelMock: vi.fn(),
  postGlMock: vi.fn(),
  snapshotMock: vi.fn(),
}));

vi.mock('@/lib/neon', () => ({ sql: sqlMock, withTransaction: vi.fn(), withSavepoint: (_n: string, fn: () => unknown) => fn() }));
vi.mock('@/modules/accounting/services/ar/customerInvoiceCancelService', () => ({
  cancelCustomerInvoice: cancelMock,
  InvoiceNotFoundError: class InvoiceNotFoundError extends Error {},
  InvoiceHasPaymentsError: class InvoiceHasPaymentsError extends Error {},
}));
vi.mock('@/modules/accounting/services/ar/customerPaymentService', () => ({ postCustomerInvoiceToGL: postGlMock }));
vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({ snapshotInvoicePdf: snapshotMock }));
// R-035 PR4: the approval gate has its own real-PG suites (r035-pr4-*); here it clears.
vi.mock('@/modules/accounting/services/gl/approvalGate', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/gl/approvalGate')>()),
  assertApprovalCleared: vi.fn(async () => undefined),
}));
// Migration 874: the line-coding pre-check has its own real-PG suite
// (invoice-line-revenue-coding.int.test.ts); here no line is coded.
vi.mock('@/modules/accounting/services/ar/invoiceLineCodingGuard', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/ar/invoiceLineCodingGuard')>()),
  storedInvoiceLinesRefusal: vi.fn(async () => null),
}));

// Real ClosedFiscalPeriodError so the route's instanceof check matches.
import { ClosedFiscalPeriodError } from '@/modules/accounting/services/gl/journalEntryService';
import handler from '../../../pages/api/accounting/customer-invoices-detail';
import { assertApprovalCleared, ApprovalRequiredError } from '@/modules/accounting/services/gl/approvalGate';
import { apiResponse } from '@/lib/apiResponse';
import { InvoiceLineCodingRefusal } from '@/modules/accounting/services/ar/invoiceLineCoding';
import { ArPostingAfterWriteError } from '@/modules/accounting/services/ar/arErrors';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
const USER_ID = 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb';
const INV_ID = '11111111-1111-4111-8111-111111111111';

function req(body: unknown): NextApiRequest {
  return { method: 'POST', body, companyId: COMPANY_ID, user: { id: USER_ID } } as unknown as NextApiRequest;
}
const call = (body: unknown) =>
  (handler as unknown as (r: NextApiRequest, s: NextApiResponse) => Promise<{ kind: string; error?: string }>)(
    req(body),
    {} as NextApiResponse,
  );

/** Concatenate a tagged-template sql call's static fragments for assertions. */
function sqlText(call: unknown[]): string {
  return (call[0] as readonly string[]).join(' ');
}
/** The interpolated values of a tagged-template sql call. */
function sqlParams(call: unknown[]): unknown[] {
  return call.slice(1);
}
/** Assert an UPDATE constrained approve to the pre-approval statuses. Fails if
 *  the `AND status = ANY(${APPROVABLE_STATUSES}::text[])` guard is removed. */
function expectApproveGuard(call: unknown[]): void {
  expect(sqlText(call)).toMatch(/UPDATE\s+customer_invoices/i);
  expect(sqlText(call)).toMatch(/status\s*=\s*ANY\s*\(/i);
  expect(sqlText(call)).toMatch(/::text\[\]/i);
  expect(
    sqlParams(call).some(
      (p) => Array.isArray(p) && p.includes('draft') && p.includes('pending_approval'),
    ),
  ).toBe(true);
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockReset();
});

describe('customer-invoices-detail POST action guards', () => {
  it('rejects approve for a cancelled invoice with a 400 and never posts GL', async () => {
    sqlMock
      .mockResolvedValueOnce([]) // the row lock (R-035) matches approvable invoices only: none, so no gate
      .mockResolvedValueOnce([]) // guarded UPDATE matches no row (status not approvable)
      .mockResolvedValueOnce([{ status: 'cancelled' }]); // existence/status probe

    const result = await call({ id: INV_ID, action: 'approve' });

    // The rejection must come from the DB guard, not just the mock returning [].
    expectApproveGuard(sqlMock.mock.calls[1]!);
    expect(result.kind).toBe('badRequest');
    expect(result.error).toMatch(/cannot approve/i);
    expect(result.error).toMatch(/cancelled/);
    expect(postGlMock).not.toHaveBeenCalled();
  });

  it('rejects send for a cancelled invoice with a 400 (cancel is terminal)', async () => {
    sqlMock
      .mockResolvedValueOnce([]) // guarded UPDATE matches no row (status = cancelled)
      .mockResolvedValueOnce([{ status: 'cancelled' }]); // existence/status probe

    const result = await call({ id: INV_ID, action: 'send' });

    // The status guard itself is proven by outcome on real PostgreSQL in
    // tests/integration/r086-send-status-guard-route.int.test.ts.
    expect(result.kind).toBe('badRequest');
    expect(result.error).toMatch(/cannot send a cancelled invoice/i);
  });

  it('returns 404 when approving a non-existent invoice', async () => {
    sqlMock
      .mockResolvedValueOnce([]) // the row lock (R-035): no such invoice
      .mockResolvedValueOnce([]) // UPDATE matches nothing
      .mockResolvedValueOnce([]); // probe: invoice does not exist

    const result = await call({ id: INV_ID, action: 'approve' });
    expect(result.kind).toBe('notFound');
    expect(postGlMock).not.toHaveBeenCalled();
  });

  it('approves a draft invoice and posts GL', async () => {
    sqlMock
      .mockResolvedValueOnce([{ status: 'draft', total_amount: '115.00' }]) // the row lock (R-035)
      .mockResolvedValueOnce([{ id: INV_ID }]); // guarded UPDATE matched a draft row
    postGlMock.mockResolvedValueOnce('je-123');
    snapshotMock.mockResolvedValueOnce({ documentId: 'doc-1', wasExisting: false });

    const result = await call({ id: INV_ID, action: 'approve' });

    // Even the happy path must go through the status-guarded UPDATE.
    expectApproveGuard(sqlMock.mock.calls[1]!);
    expect(result.kind).toBe('success');
    // This route is a human clicking Approve, so it must NOT supply a posting
    // agent — the AR journal keeps its human:<userId> attribution. Only the
    // MCP finalize_invoice tool passes one.
    const glCall = postGlMock.mock.calls[0]!;
    expect(glCall.slice(0, 3)).toEqual([COMPANY_ID, INV_ID, USER_ID]);
    expect((glCall[3] as { postingAgent?: string } | undefined)?.postingAgent).toBeUndefined();
  });

  // 'NaN' only by hand (migration 692 refuses it), but `<= 0` would let it through.
  it.each(['0.00', 'NaN'])('a draft totalling %s is a 400 under the row lock: no status UPDATE, nothing posted', async (total) => {
    sqlMock.mockResolvedValueOnce([{ status: 'draft', total_amount: total }]); // the row lock (R-035)

    await call({ id: INV_ID, action: 'approve' });

    expect(apiResponse.badRequest).toHaveBeenCalledWith(expect.anything(),
      'This invoice totals 0.00, so there is nothing to post. Add a charge, or delete the draft.');
    expect(sqlMock.mock.calls.some((c) => /UPDATE\s+customer_invoices/i.test(sqlText(c)))).toBe(false);
    expect(postGlMock).not.toHaveBeenCalled();
  });

  it('a legacy NEGATIVE total is not refused as "totals 0.00": bulk finalize skips only zero, and so does approve', async () => {
    sqlMock.mockResolvedValueOnce([{ status: 'draft', total_amount: '-50.00' }]).mockResolvedValueOnce([{ id: INV_ID }]);
    postGlMock.mockResolvedValueOnce('je-123');
    snapshotMock.mockResolvedValueOnce({ documentId: 'doc-1', wasExisting: false });

    await call({ id: INV_ID, action: 'approve' });

    expect(apiResponse.badRequest).not.toHaveBeenCalled();
    expectApproveGuard(sqlMock.mock.calls[1]!);
  });

  it('migration 874: a line refusal raised by posting AFTER the status UPDATE is a 5xx class, never the pre-write 400', async () => {
    sqlMock.mockResolvedValueOnce([{ status: 'draft', total_amount: '115.00' }]).mockResolvedValueOnce([{ id: INV_ID }]);
    postGlMock.mockRejectedValueOnce(new InvoiceLineCodingRefusal('Invoice INV-1: cost centre CC2 is inactive.'));
    await expect(call({ id: INV_ID, action: 'approve' })).rejects.toBeInstanceOf(ArPostingAfterWriteError);
    expect(apiResponse.badRequest).not.toHaveBeenCalled();
  });

  it('R-035: consults the approval gate for a draft under the row lock, BEFORE the guarded UPDATE', async () => {
    sqlMock.mockResolvedValueOnce([{ status: 'draft', total_amount: '115.00' }]).mockResolvedValueOnce([{ id: INV_ID }]);
    postGlMock.mockResolvedValueOnce('je-123');
    snapshotMock.mockResolvedValueOnce({ documentId: 'doc-1', wasExisting: false });

    await call({ id: INV_ID, action: 'approve' });

    // FOR NO KEY UPDATE, approvable only (review F2): an FK insert's KEY SHARE is not held off.
    expect(sqlText(sqlMock.mock.calls[0]!)).toMatch(/SELECT status, currency_code, total_amount FROM customer_invoices[\s\S]*status = ANY\([\s\S]*FOR NO KEY UPDATE/);
    expect(assertApprovalCleared).toHaveBeenCalledWith(COMPANY_ID, 'customer_invoice', INV_ID);
    const gateAt = vi.mocked(assertApprovalCleared).mock.invocationCallOrder[0]!;
    expect(gateAt).toBeGreaterThan(sqlMock.mock.invocationCallOrder[0]!);
    expect(gateAt).toBeLessThan(sqlMock.mock.invocationCallOrder[1]!);
  });

  it('R-035: a gate refusal answers 409 and the guarded UPDATE never runs', async () => {
    sqlMock.mockResolvedValueOnce([{ status: 'draft', total_amount: '115.00' }]);
    vi.mocked(assertApprovalCleared).mockRejectedValueOnce(new ApprovalRequiredError({
      reason: 'APPROVAL_REQUIRED', requiredRole: 'owner', ruleName: 'r', requestId: null,
      documentType: 'customer_invoice', documentReference: 'INV-1',
    }));

    await call({ id: INV_ID, action: 'approve' });

    expect(apiResponse.conflict).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/needs owner approval/),
      { reason: 'APPROVAL_REQUIRED', requiredRole: 'owner', requestId: null });
    expect(sqlMock).toHaveBeenCalledTimes(1);
    expect(postGlMock).not.toHaveBeenCalled();
  });

  it('maps a closed-period reversal error on cancel to a 400, not a 500', async () => {
    cancelMock.mockRejectedValueOnce(new ClosedFiscalPeriodError('closed'));

    const result = await call({ id: INV_ID, action: 'cancel' });

    expect(result.kind).toBe('badRequest');
    expect(result.error).toMatch(/closed fiscal period/i);
  });
});
