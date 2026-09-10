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

// Isolate route and invoice lifecycle guards; actual auth is exercised in forensic integration.
vi.mock('@/modules/accounting/services/ar/arControlBoundary',async()=>({
 ...await vi.importActual<typeof import('@/modules/accounting/services/ar/arControlBoundary')>('@/modules/accounting/services/ar/arControlBoundary'),
 requireArControl:vi.fn(),
 runArControlled:async(_company:string,_person:string,_ref:unknown,_opts:unknown,effect:(permit:unknown)=>Promise<unknown>)=>effect({accountingDate:'2026-09-09'}),
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
  },
}));

const { sqlMock, cancelMock, postGlMock, snapshotMock } = vi.hoisted(() => ({
  sqlMock: Object.assign(vi.fn(), { transaction: vi.fn() }),
  cancelMock: vi.fn(),
  postGlMock: vi.fn(),
  snapshotMock: vi.fn(),
}));

vi.mock('@/lib/neon', () => ({ sql: sqlMock, withTransaction: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/customerInvoiceCancelService', () => ({
  cancelCustomerInvoice: cancelMock,
  InvoiceNotFoundError: class InvoiceNotFoundError extends Error {},
  InvoiceHasPaymentsError: class InvoiceHasPaymentsError extends Error {},
}));
vi.mock('@/modules/accounting/services/ar/customerInvoiceFinancialEffect', () => ({ postCustomerInvoiceFinancialEffect: postGlMock }));
vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({ snapshotInvoicePdf: snapshotMock }));

// Real ClosedFiscalPeriodError so the route's instanceof check matches.
import { ClosedFiscalPeriodError } from '@/modules/accounting/services/gl/journalEntryService';
import handler from '../../../pages/api/accounting/customer-invoices-detail';

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
      .mockResolvedValueOnce([]) // guarded UPDATE matches no row (status not approvable)
      .mockResolvedValueOnce([{ status: 'cancelled' }]); // existence/status probe

    const result = await call({ id: INV_ID, action: 'approve' });

    // The rejection must come from the DB guard, not just the mock returning [].
    expectApproveGuard(sqlMock.mock.calls[0]!);
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

    const updateText = (sqlMock.mock.calls[0]![0] as readonly string[]).join(' ');
    expect(updateText).toMatch(/status != 'cancelled'/i);
    expect(result.kind).toBe('badRequest');
    expect(result.error).toMatch(/cannot send a cancelled invoice/i);
  });

  it('returns 404 when approving a non-existent invoice', async () => {
    sqlMock
      .mockResolvedValueOnce([]) // UPDATE matches nothing
      .mockResolvedValueOnce([]); // probe: invoice does not exist

    const result = await call({ id: INV_ID, action: 'approve' });
    expect(result.kind).toBe('notFound');
    expect(postGlMock).not.toHaveBeenCalled();
  });

  it('approves a draft invoice and posts GL', async () => {
    sqlMock.mockResolvedValueOnce([{ id: INV_ID }]); // guarded UPDATE matched a draft row
    postGlMock.mockResolvedValueOnce('je-123');
    snapshotMock.mockResolvedValueOnce({ documentId: 'doc-1', wasExisting: false });

    const result = await call({ id: INV_ID, action: 'approve' });

    // Even the happy path must go through the status-guarded UPDATE.
    expectApproveGuard(sqlMock.mock.calls[0]!);
    expect(result.kind).toBe('success');
    // This route is a human clicking Approve, so it must NOT supply a posting
    // agent — the AR journal keeps its human:<userId> attribution. Only the
    // MCP finalize_invoice tool passes one.
    const glCall = postGlMock.mock.calls[0]!;
    expect(glCall.slice(0, 3)).toEqual([COMPANY_ID, INV_ID, USER_ID]);
    expect((glCall[3] as { postingAgent?: string } | undefined)?.postingAgent).toBeUndefined();
  });

  it('maps a closed-period reversal error on cancel to a 400, not a 500', async () => {
    cancelMock.mockRejectedValueOnce(new ClosedFiscalPeriodError('closed'));

    const result = await call({ id: INV_ID, action: 'cancel' });

    expect(result.kind).toBe('badRequest');
    expect(result.error).toMatch(/closed fiscal period/i);
  });
});
