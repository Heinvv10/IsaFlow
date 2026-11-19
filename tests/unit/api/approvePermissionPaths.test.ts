/**
 * #1656 review of #1670 (M2): every other AP/AR approval path asks the module's Approve
 * (core/approvePermission.ts), before it reads or writes the document:
 *   - credit notes: approveCreditNote itself (both routes, the MCP tool and the MCP bulk tool go
 *     through it), by the note's type (customer: Customers & AR, supplier: Suppliers & AP); the
 *     credit-notes-action route answers the refusal 403; the MCP tool and bulk tool refuse / skip
 *     from a read;
 *   - purchase-order approve, payment-batch approve, and approving an approval request for a
 *     supplier invoice: Suppliers & AP.
 * A manager with the default (approve) is let through each, so the refusal is the permission's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { permissionDb, permissionSql } from '../helpers/permissionSqlMock';

const C = '11111111-1111-4111-8111-111111111111';
const U = '99999999-9999-4999-8999-999999999999';
const ID = '66666666-6666-4666-8666-666666666666';
let db = permissionDb();
let requestDocType = 'supplier_invoice';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true) }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: (_n: string, fn: () => unknown) => fn() }));
vi.mock('@/lib/auth/impersonationGuard', async (orig) => ({ ...(await orig<object>()), assertNotImpersonating: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/creditNoteLock', () => ({ lockCreditNoteForUpdate: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/creditNotePostingChecks', async (orig) => ({ ...(await orig<object>()), lockInvoiceCreditNotes: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/approvalGate', async (orig) => ({ ...(await orig<object>()), assertApprovalCleared: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/purchaseOrderApprove', async (orig) => ({ ...(await orig<object>()), approvePurchaseOrder: vi.fn(async () => ({ purchaseOrder: { id: ID } })) }));
vi.mock('@/modules/accounting/services/ap/batchPaymentApproval', async (orig) => ({ ...(await orig<object>()), approveBatch: vi.fn(async () => 'approved') }));
vi.mock('@/modules/accounting/services/gl/approvalService', async (orig) => ({ ...(await orig<object>()), decideRequest: vi.fn(async () => ({ id: ID })) }));

import { sql } from '@/lib/neon';
import { lockCreditNoteForUpdate } from '@/modules/accounting/services/ar/creditNoteLock';
import { assertApprovalCleared } from '@/modules/accounting/services/gl/approvalGate';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { ApprovePermissionError } from '@/modules/accounting/services/core/approvePermission';
import { respondIfApprovePermissionRefused } from '@/lib/approvePermissionResponse';
import { approvePurchaseOrder } from '@/modules/accounting/services/ap/purchaseOrderApprove';
import { approveBatch } from '@/modules/accounting/services/ap/batchPaymentApproval';
import { decideRequest } from '@/modules/accounting/services/gl/approvalService';
import poApprove from '../../../pages/api/accounting/purchase-orders/[id]/approve';
import batchAction from '../../../pages/api/accounting/batch-payments-action';
import approvalRequests from '../../../pages/api/accounting/approval-requests';

const STOP = new Error('reached the approval gate');

function member(role: string, module?: string, canApprove?: boolean) {
  db.members.set(`${C}:${U}`, role);
  if (module) db.rows.set(`${C}:${U}:${module}`, { can_read: true, can_write: true, can_approve: canApprove });
}

function call(handler: unknown, body: unknown, query: Record<string, string> = {}) {
  const req = { method: 'POST', query, body, companyId: C, companyRole: 'manager', user: { id: U } } as unknown as NextApiRequest;
  const res = {
    statusCode: 200, sent: undefined as unknown,
    setHeader() { return this; }, status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.sent = p; return this; }, end() { return this; },
  };
  return Promise.resolve((handler as (q: NextApiRequest, s: NextApiResponse) => unknown)(req, res as unknown as NextApiResponse)).then(() => res);
}

beforeEach(() => {
  vi.clearAllMocks();
  db = permissionDb();
  requestDocType = 'supplier_invoice';
  vi.mocked(sql).mockImplementation(permissionSql(db, (text) =>
    (text.includes('FROM approval_requests') ? [{ document_type: requestDocType, document_id: ID }] : [])) as never);
  vi.mocked(assertApprovalCleared).mockRejectedValue(STOP);
});

describe('approveCreditNote (every credit-note approval path)', () => {
  const note = (type: string) => vi.mocked(lockCreditNoteForUpdate).mockResolvedValue({ id: ID, status: 'draft', type } as never);

  it('a supplier note: no Suppliers & AP Approve is refused before the approval gate or any write', async () => {
    note('supplier'); member('manager', 'suppliers', false);
    const err = await approveCreditNote(C, ID, U).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApprovePermissionError);
    expect((err as ApprovePermissionError).module).toBe('suppliers');
    expect(assertApprovalCleared).not.toHaveBeenCalled();
  });

  it("a customer note asks Customers & AR, not Suppliers & AP", async () => {
    note('customer'); member('manager', 'customers', false);
    db.rows.set(`${C}:${U}:suppliers`, { can_approve: true });
    const err = await approveCreditNote(C, ID, U).catch((e: unknown) => e);
    expect((err as ApprovePermissionError).module).toBe('customers');
    expect(db.reads.map((r) => r.moduleKey)).toEqual(['customers']);
  });

  it('a manager with the default goes on to the approval gate', async () => {
    note('supplier'); member('manager');
    expect(await approveCreditNote(C, ID, U).catch((e: unknown) => e)).toBe(STOP);
  });

  it('a route answers the refusal 403 with its message', () => {
    const res = { statusCode: 0, sent: undefined as unknown, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.sent = p; return this; } };
    expect(respondIfApprovePermissionRefused(res as never, new ApprovePermissionError('suppliers', 'supplier credit notes'))).toBe(true);
    expect(res.statusCode).toBe(403);
    expect(respondIfApprovePermissionRefused(res as never, new Error('other'))).toBe(false);
  });
});

describe('purchase order, payment batch and approval request (Suppliers & AP)', () => {
  it('purchase-order approve: 403 before the order is read; the default manager approves', async () => {
    member('manager', 'suppliers', false);
    expect((await call(poApprove, {}, { id: ID })).statusCode).toBe(403);
    expect(approvePurchaseOrder).not.toHaveBeenCalled();
    db.rows.clear();
    expect((await call(poApprove, {}, { id: ID })).statusCode).toBe(200);
    expect(approvePurchaseOrder).toHaveBeenCalledTimes(1);
  });

  it('payment-batch approve: 403 before the batch is read; the default manager approves', async () => {
    member('manager', 'suppliers', false);
    expect((await call(batchAction, { action: 'approve', id: ID })).statusCode).toBe(403);
    expect(approveBatch).not.toHaveBeenCalled();
    db.rows.clear();
    expect((await call(batchAction, { action: 'approve', id: ID })).statusCode).toBe(200);
    expect(approveBatch).toHaveBeenCalledTimes(1);
  });

  it('approving a supplier-invoice approval request: 403 before decideRequest; rejecting it is not an approval', async () => {
    member('manager', 'suppliers', false);
    expect((await call(approvalRequests, { action: 'approve', requestId: ID })).statusCode).toBe(403);
    expect(decideRequest).not.toHaveBeenCalled();
    expect((await call(approvalRequests, { action: 'reject', requestId: ID })).statusCode).toBe(200);
    expect(decideRequest).toHaveBeenCalledTimes(1);
  });

  it('a request for a document no module governs (a manual journal) is not asked about', async () => {
    member('manager', 'suppliers', false);
    requestDocType = 'manual_journal';
    expect((await call(approvalRequests, { action: 'approve', requestId: ID })).statusCode).toBe(200);
  });
});
