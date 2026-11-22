/** BREAKER R2-D (#1670): POST /api/accounting/ai-invoice-pipeline, the twin of capture/[id]/post, still stores an 'approved' bill for a manager without Suppliers & AP Approve. */
import { describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
const S = '22222222-2222-4222-8222-222222222222';
const inserted: unknown[][] = [];
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/apiDocumentLock', () => ({ respondIfLockTimeout: () => false }));
vi.mock('@/lib/rateLimit', () => ({ checkAiRateLimit: vi.fn(async () => true) }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async (s: TemplateStringsArray, ...v: unknown[]) => {
  const t = s.join('?');
  if (t.includes('company_user_permissions')) return [{ role: 'manager', has_row: true, can_read: true, can_write: true, can_delete: false, can_export: true, can_approve: false }];
  if (t.includes('FROM suppliers')) return [{ id: S, name: 'Acme', vat_number: null }];
  if (t.includes('INSERT INTO supplier_invoices')) { inserted.push(v); return [{ id: 'bill-1', invoice_number: 'INV1', status: v.find((x) => x === 'approved' || x === 'draft') }]; }
  return [];
}) }));
vi.mock('@/modules/accounting/services/core/aiInvoicePipelineService', async (orig) => ({
  ...(await orig<object>()),
  validatePipelineInput: () => ({ valid: true, errors: [], warnings: [] }),
  matchSupplierFromExtraction: () => ({ supplierId: S, supplierName: 'Acme', confidence: 1 }),
  buildInvoiceFromExtraction: () => ({ invoiceNumber: 'INV1', totalAmount: 115, taxAmount: 15, taxRate: 15, invoiceDate: '2026-11-01', items: [] }),
  computePipelineConfidence: () => 0.99,
}));
vi.mock('@/modules/accounting/services/core/unattendedPostingGate', () => ({ refusesUnattendedApproval: () => false }));
vi.mock('@/modules/accounting/services/capture/captureDeduplicationService', () => ({ computeFingerprint: () => 'fp', findDuplicate: async () => null }));
vi.mock('@/modules/accounting/services/capture/supplierRulesService', () => ({ getRule: async () => null, recordCoding: async () => undefined }));
vi.mock('@/modules/accounting/services/capture/captureBillLines', () => ({
  extractedBillDueDate: async () => ({ dueDate: '2026-12-01', source: 'terms' }), insertCaptureBillLines: async () => null, planCaptureBillLines: async () => ({ lines: [] }) }));
vi.mock('@/modules/accounting/services/capture/capturePostingClaim', () => ({ respondCapturedDocumentRefusal: vi.fn() }));
vi.mock('@/modules/accounting/services/capture/captureRowLock', () => ({
  CAPTURED_DOCUMENT_REFUSAL_MESSAGE: {}, claimCapturedDocumentForPosting: async () => null, refusalForPosting: () => null,
  lockCapturedDocumentForUpdate: async () => ({ extracted_data: { vendorName: 'Acme' } }), lockPostableCaptureEventIds: async () => [],
  markCaptureEventsDuplicate: async () => undefined, markCaptureEventsPosted: async () => undefined }));
vi.mock('@/modules/accounting/services/capture/captureReadState', () => ({ isBeingRead: () => false, STILL_BEING_READ: 'x' }));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceWorkflowService', () => ({ performThreeWayMatch: async () => null }));
vi.mock('@/modules/accounting/services/capture/provisionalAttachSettle', () => ({ attachEvidenceAndSettleApproved: async () => ({ settlementRefused: false }) }));
vi.mock('@/modules/accounting/services/capture/alertResolutionService', () => ({ resolvePendingAlertForInvoice: async () => undefined }));
vi.mock('@/modules/accounting/services/gl/approvalUnattended', () => ({
  raiseUnattendedApproval: vi.fn(), unattendedBillStatus: vi.fn(async (_c: string, ok: boolean) => ({ status: ok ? 'approved' : 'draft', gated: false })) }));

import handler from '../../../pages/api/accounting/ai-invoice-pipeline';
import { mayApproveSupplierInvoices } from '@/modules/accounting/services/ap/billApprovePermission';

describe('R2-D', () => {
  it('the AI pipeline must not store an approved bill for a manager without Approve', async () => {
    const C = '11111111-1111-4111-8111-111111111111', U = '99999999-9999-4999-8999-999999999999';
    expect(await mayApproveSupplierInvoices(C, U)).toBe(false);
    const req = { method: 'POST', query: {}, body: { documentId: '33333333-3333-4333-8333-333333333333' }, companyId: C, companyRole: 'manager', user: { id: U } } as unknown as NextApiRequest;
    const res = { statusCode: 200, sent: undefined as unknown, setHeader() { return this; }, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.sent = p; return this; }, end() { return this; } };
    await (handler as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(req, res as unknown as NextApiResponse);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).not.toContain('approved');
  });
});
