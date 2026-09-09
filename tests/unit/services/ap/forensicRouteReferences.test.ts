import { expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
const calls = vi.hoisted(() => ({ payment: vi.fn(async () => ({})), invoice: vi.fn(async () => ({})) }));
vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/ap/supplierPaymentService', () => ({ approveSupplierPayment: calls.payment, processSupplierPayment: calls.payment }));
vi.mock('@/modules/accounting/services/ap/supplierPaymentWorkflowService', () => ({ voidSupplierPayment: calls.payment }));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceService', () => ({ approveSupplierInvoice: calls.invoice, cancelSupplierInvoice: calls.invoice, performThreeWayMatch: calls.invoice }));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceWorkflowService', () => ({ postSupplierInvoiceToGL: calls.invoice }));
import payment from '../../../../pages/api/accounting/supplier-payments-action';
import invoice from '../../../../pages/api/accounting/supplier-invoices-action';
import bulk from '../../../../pages/api/accounting/supplier-invoices-bulk-action';
const entity = '00000000-0000-4000-8000-000000000001', approval = '00000000-0000-4000-8000-000000000002';
function req(body: unknown) { return { method: 'POST', body, companyId: 'company', user: { id: 'person' } } as unknown as NextApiRequest; }
function res() { return { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as NextApiResponse; }
it('forwards payment approval reference to shared writer', async () => {
  await payment(req({ action: 'process', paymentId: entity, approvalId: approval }), res());
  expect(calls.payment).toHaveBeenLastCalledWith('company', entity, 'person', { approvalId: approval });
});
it('forwards invoice approval reference to shared writer', async () => {
  await invoice(req({ action: 'approve', invoiceId: entity, approvalId: approval }), res());
  expect(calls.invoice).toHaveBeenLastCalledWith('company', entity, 'person', { approvalId: approval });
});
it('forwards each bulk entity own approval reference', async () => {
  await bulk(req({ action: 'post_gl', invoiceIds: [entity], approvalIds: { [entity]: approval } }), res());
  expect(calls.invoice).toHaveBeenLastCalledWith('company', entity, 'person', { approvalId: approval });
});
