/**
 * #1656 review of #1670 (M2): every other AP/AR approval path asks the module's Approve
 * (core/approvePermission.ts), before it reads or writes the document:
 *   - credit notes, by the note's type (customer: Customers & AR, supplier: Suppliers & AP):
 *     credit-notes-action approve and supplier-credit-notes post answer 403 (the MCP tool and bulk
 *     tool refuse / skip from a read: creditNoteToolsApprove / bulkApproveCreditNotesTool tests);
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
vi.mock('@/modules/accounting/services/ar/creditNoteService', async (orig) => ({ ...(await orig<object>()),
  approveCreditNote: vi.fn(async () => ({ id: ID, status: 'approved' })), getCreditNoteById: vi.fn(async () => ({ id: ID, type: 'supplier' })),
  createCreditNote: vi.fn(async () => ({ id: ID, status: 'draft' })) }));
vi.mock('@/modules/accounting/services/shared/creditNoteFifo', async (orig) => ({ ...(await orig<object>()), listCreditNoteAllocations: vi.fn(async () => []) }));
vi.mock('@/modules/accounting/services/ap/purchaseOrderApprove', async (orig) => ({ ...(await orig<object>()), approvePurchaseOrder: vi.fn(async () => ({ purchaseOrder: { id: ID } })) }));
vi.mock('@/modules/accounting/services/ap/batchPaymentApproval', async (orig) => ({ ...(await orig<object>()), approveBatch: vi.fn(async () => 'approved') }));
vi.mock('@/modules/accounting/services/gl/approvalService', async (orig) => ({ ...(await orig<object>()), decideRequest: vi.fn(async () => ({ id: ID })) }));

import { sql } from '@/lib/neon';
import { approveCreditNote, createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { ApprovePermissionError } from '@/modules/accounting/services/core/approvePermission';
import { respondIfApprovePermissionRefused } from '@/lib/approvePermissionResponse';
import { approvePurchaseOrder } from '@/modules/accounting/services/ap/purchaseOrderApprove';
import { approveBatch } from '@/modules/accounting/services/ap/batchPaymentApproval';
import { decideRequest } from '@/modules/accounting/services/gl/approvalService';
import poApprove from '../../../pages/api/accounting/purchase-orders/[id]/approve';
import batchAction from '../../../pages/api/accounting/batch-payments-action';
import approvalRequests from '../../../pages/api/accounting/approval-requests';
import creditNotesAction from '../../../pages/api/accounting/credit-notes-action';
import supplierCreditNotes from '../../../pages/api/accounting/supplier-credit-notes';

let noteType = 'customer';

function member(role: string, module?: string, canApprove?: boolean) {
  db.members.set(`${C}:${U}`, role);
  if (module) db.rows.set(`${C}:${U}:${module}`, { can_read: true, can_write: true, can_approve: canApprove });
}

function call(handler: unknown, body: unknown, query: Record<string, string> = {}, method = 'POST') {
  const req = { method, query, body, companyId: C, companyRole: 'manager', user: { id: U } } as unknown as NextApiRequest;
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
  noteType = 'customer';
  vi.mocked(sql).mockImplementation(permissionSql(db, (text) => {
    if (text.includes('FROM approval_requests')) return [{ document_type: requestDocType, document_id: ID }];
    if (text.includes('FROM credit_notes')) return [{ type: noteType }];
    return [];
  }) as never);
});

describe('credit notes (by the note type)', () => {
  it('credit-notes-action approve of a customer note asks Customers & AR: 403 before approve; a Suppliers grant does not count', async () => {
    member('manager', 'customers', false);
    db.rows.set(`${C}:${U}:suppliers`, { can_approve: true });
    const res = await call(creditNotesAction, { action: 'approve', creditNoteId: ID });
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.sent)).toMatch(/customer credit notes/);
    expect(db.reads.map((r) => r.moduleKey)).toEqual(['customers']);
    expect(approveCreditNote).not.toHaveBeenCalled();
  });

  it('credit-notes-action approve of a supplier note asks Suppliers & AP; the default manager approves', async () => {
    noteType = 'supplier'; member('manager');
    expect((await call(creditNotesAction, { action: 'approve', creditNoteId: ID })).statusCode).toBe(200);
    expect(db.reads.map((r) => r.moduleKey)).toEqual(['suppliers']);
    expect(approveCreditNote).toHaveBeenCalledTimes(1);
  });

  it('supplier-credit-notes create-and-post (POST): 403 BEFORE the draft is created, so a retry duplicates nothing', async () => {
    member('manager', 'suppliers', false);
    const res = await call(supplierCreditNotes, { submitAction: 'post', supplierId: ID, creditDate: '2026-11-19',
      lineItems: [{ description: 'x', quantity: 1, unitPrice: 10 }] });
    expect(res.statusCode).toBe(403);
    expect(createCreditNote).not.toHaveBeenCalled();
    expect(approveCreditNote).not.toHaveBeenCalled();
  });

  it('supplier-credit-notes post: 403 before approve without Suppliers & AP Approve', async () => {
    member('manager', 'suppliers', false);
    const res = await call(supplierCreditNotes, { id: ID, action: 'post' }, {}, 'PATCH');
    expect(res.statusCode).toBe(403);
    expect(approveCreditNote).not.toHaveBeenCalled();
  });

  it('a route answers the refusal 403 with its message (respondIfApprovePermissionRefused)', () => {
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

  it.each([['customer_invoice', 'customers'], ['manual_journal', 'accounts'], ['pay_run', 'payroll'], ['purchase_order', 'suppliers']])(
    'a %s request takes %s Approve', async (type, module) => {
      member('manager', module, false);
      requestDocType = type;
      expect((await call(approvalRequests, { action: 'approve', requestId: ID })).statusCode).toBe(403);
      expect(db.reads.map((r) => r.moduleKey)).toEqual([module]);
      expect(decideRequest).not.toHaveBeenCalled();
    });

  it.each([['customer', 'customers'], ['supplier', 'suppliers']])(
    "a legacy credit_note request takes the note's own module (a %s note: %s)", async (type, module) => {
      member('manager', module, false);
      requestDocType = 'credit_note'; noteType = type;
      expect((await call(approvalRequests, { action: 'approve', requestId: ID })).statusCode).toBe(403);
      expect(db.reads.map((r) => r.moduleKey)).toEqual([module]);
      db.rows.clear();
      expect((await call(approvalRequests, { action: 'approve', requestId: ID })).statusCode).toBe(200);
    });

  it('fails closed: an unknown type is refused, and so is a legacy credit_note of an unknown note type', async () => {
    member('owner');
    requestDocType = 'something_new';
    expect((await call(approvalRequests, { action: 'approve', requestId: ID })).statusCode).toBe(403);
    requestDocType = 'credit_note'; noteType = 'unknown';
    expect((await call(approvalRequests, { action: 'approve', requestId: ID })).statusCode).toBe(403);
    expect(decideRequest).not.toHaveBeenCalled();
  });

  it("a legacy credit_note whose note is gone is left to the decide path, which answers 404 (r035-approval-contract L2)", async () => {
    member('manager', 'customers', false);
    requestDocType = 'credit_note'; noteType = '';
    vi.mocked(sql).mockImplementation(permissionSql(db, (text) => {
      if (text.includes('FROM approval_requests')) return [{ document_type: 'credit_note', document_id: ID }];
      return []; // no credit_notes row
    }) as never);
    await call(approvalRequests, { action: 'approve', requestId: ID });
    expect(decideRequest).toHaveBeenCalledTimes(1);
    expect(db.reads).toEqual([]);
  });

  it.each([['payment', 'suppliers'], ['journal_entry', 'accounts'], ['budget_version', 'budgets']])(
    'no type is ungated (Hein: gate everything): a legacy %s request takes %s Approve', async (type, module) => {
      member('manager', module, false);
      requestDocType = type;
      expect((await call(approvalRequests, { action: 'approve', requestId: ID })).statusCode).toBe(403);
      expect(db.reads.map((r) => r.moduleKey)).toEqual([module]);
      expect(decideRequest).not.toHaveBeenCalled();
    });
});
