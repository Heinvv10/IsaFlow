/**
 * #1656 review of #1670, breaker R2 (ported): posting a capture inserts the bill already approved when
 * the gate auto-publishes it. A manager whose Suppliers & AP "Approve" is unticked must get a draft
 * routed to manual review instead; a manager with the default (approve) keeps the auto-approval.
 */
import { describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { permissionDb, permissionSql } from '../helpers/permissionSqlMock';
const S = '22222222-2222-4222-8222-222222222222';
const inserted: unknown[][] = [];
const C = '11111111-1111-4111-8111-111111111111', U = '99999999-9999-4999-8999-999999999999';
const db = permissionDb();
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/apiDocumentLock', () => ({ respondIfLockTimeout: () => false }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn((s: TemplateStringsArray, ...v: unknown[]) => permissionSql(db, (t, values) => {
  if (t.includes('FROM suppliers')) return [{ id: S, name: 'Acme', vat_number: null }];
  if (t.includes('INSERT INTO supplier_invoices')) { inserted.push(values); return [{ id: 'bill-1', invoice_number: 'INV1', status: values[12] }]; }
  return [];
})(s, ...v)) }));
vi.mock('@/modules/accounting/services/core/aiInvoicePipelineService', async (orig) => ({
  ...(await orig<object>()),
  validatePipelineInput: () => ({ valid: true, errors: [], warnings: [] }),
  matchSupplierFromExtraction: () => ({ supplierId: S, supplierName: 'Acme', confidence: 1 }),
  buildInvoiceFromExtraction: () => ({ invoiceNumber: 'INV1', totalAmount: 115, taxAmount: 15, taxRate: 15, invoiceDate: '2026-11-01' }),
  computePipelineConfidence: () => 0.99,
}));
vi.mock('@/modules/accounting/services/core/unattendedPostingGate', () => ({ refusesUnattendedApproval: () => false }));
vi.mock('@/modules/accounting/services/capture/autoPublishGateService', () => ({ decide: vi.fn(async () => ({ outcome: 'auto_publish', reasons: [] })) }));
vi.mock('@/modules/accounting/services/gl/approvalUnattended', () => ({
  raiseUnattendedApproval: vi.fn(), unattendedBillStatus: vi.fn(async (_c: string, ok: boolean) => ({ status: ok ? 'approved' : 'draft', gated: false })) }));
vi.mock('@/modules/accounting/services/capture/captureEventLock', () => ({ isCaptureEventPostable: () => true }));
vi.mock('@/modules/accounting/services/capture/captureDeduplicationService', () => ({ computeFingerprint: () => 'fp' }));
vi.mock('@/modules/accounting/services/capture/captureBillLines', () => ({
  extractedBillDueDate: async () => ({ dueDate: '2026-12-01', source: 'terms' }), insertCaptureBillLines: async () => null, planCaptureBillLines: async () => ({ lines: [] }) }));
vi.mock('@/modules/accounting/services/capture/capturePostFollowUps', () => ({
  runCapturePostFollowUps: async () => ({ provisionalAttach: { settlementRefused: false }, threeWayMatch: null }) }));
vi.mock('@/modules/accounting/services/capture/capturePostingClaim', () => ({ respondCapturedDocumentRefusal: vi.fn() }));
vi.mock('@/modules/accounting/services/capture/captureRowLock', () => ({
  CAPTURED_DOCUMENT_REFUSAL_MESSAGE: {}, claimCapturedDocumentForPosting: async () => null, refusalForPosting: () => null,
  lockCaptureEventForPosting: async () => ({ eventStatus: 'extracted', documentStatus: 'extracted', documentPostedAt: null, extractedData: { vendorName: 'Acme' }, documentId: '33333333-3333-4333-8333-333333333333', resolvedGlAccountId: null }) }));

import handler from '../../../pages/api/accounting/capture/[id]/post';

async function post() {
  inserted.length = 0;
  const req = { method: 'POST', query: { id: 'ev1' }, body: {}, companyId: C, companyRole: 'manager', user: { id: U } } as unknown as NextApiRequest;
  const res = { statusCode: 200, sent: undefined as unknown, setHeader() { return this; }, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.sent = p; return this; }, end() { return this; } };
  await (handler as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(req, res as unknown as NextApiResponse);
  return res;
}

describe('capture post (R2)', () => {
  it('a manager without Approve: the bill is stored a draft for review, not approved', async () => {
    db.members.set(`${C}:${U}`, 'manager');
    db.rows.set(`${C}:${U}:suppliers`, { can_read: true, can_write: true, can_approve: false });
    const res = await post();
    expect(inserted, JSON.stringify(res.sent)).toHaveLength(1);
    expect(inserted[0]![12]).toBe('draft');
  });

  it('a manager with the default keeps the auto-approval the gate gave', async () => {
    db.rows.clear();
    db.members.set(`${C}:${U}`, 'manager');
    const res = await post();
    expect(inserted, JSON.stringify(res.sent)).toHaveLength(1);
    expect(inserted[0]![12]).toBe('approved');
  });
});
