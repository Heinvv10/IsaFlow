/**
 * Budgets P5-2b (coordinator's ruling, 2026-11-04, fail closed): in capture/[id]/post and ai-invoice-pipeline the
 * slip attach may re-plan the bill lines' inherited dimensions (`captureSlipReplan`), and migration 873 hashes those
 * dimensions into the R-035 digest. So a gated bill's approval request must be raised AFTER the attach, never before
 * it, and the attach must be handed what the line plan inherited (`slip`). Route-level pins on call order; the
 * re-plan itself is proven on real PG (tests/integration/budgets-p5-off-slice-capture-slip.int.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiResponse } from 'next';

const order = vi.hoisted(() => [] as string[]);
const SLIP = vi.hoisted(() => ({ plannedJeId: 'je-planned', inheritedItemIds: ['item-1'], blankItemIds: ['item-1'] }));
const attachOut = vi.hoisted(() => ({ current: { attachedJeId: null, bankTxId: null } as Record<string, unknown> }));

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
// The handlers run without withAuth: a client that accepts the row locks' SET LOCAL (as capturePostFingerprint.test.ts).
vi.mock('@/lib/als', () => ({ als: { getStore: () => ({ client: { query: async () => undefined } }) }, assertTxUsable: () => undefined }));
vi.mock('@/lib/rateLimit', () => ({ checkAiRateLimit: vi.fn(async () => true) }));
vi.mock('@/lib/apiResponse', () => ({
  ErrorCode: { CONFLICT: 'CONFLICT' },
  apiResponse: Object.fromEntries(['success', 'badRequest', 'notFound', 'error', 'internalError', 'methodNotAllowed', 'conflict', 'tooManyRequests']
    .map((k) => [k, vi.fn((_res: unknown, data: unknown) => ({ kind: k, data }))])),
}));
const { sqlMock } = vi.hoisted(() => ({ sqlMock: Object.assign(vi.fn(), { unsafe: vi.fn((s: string) => s) }) }));
vi.mock('@/lib/neon', () => ({
  sql: sqlMock, withSavepoint: (_n: string, fn: () => unknown) => fn(), withTransaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(sqlMock)),
}));
vi.mock('@/modules/accounting/services/core/aiInvoicePipelineService', () => ({
  validatePipelineInput: vi.fn(() => ({ valid: true, errors: [], warnings: [] })),
  matchSupplierFromExtraction: vi.fn(() => ({ supplierId: 'ffffffff-0000-0000-0000-ffffffffffff', supplierName: 'ACME', confidence: 0.99 })),
  buildInvoiceFromExtraction: vi.fn(() => ({ invoiceNumber: 'INV-1', invoiceDate: '2026-08-13', totalAmount: 920, taxAmount: 120, taxRate: 15, items: [] })),
  determineApprovalRoute: vi.fn(() => 'auto_approve'),
  computePipelineConfidence: vi.fn(() => 0.97),
}));
vi.mock('@/modules/accounting/services/capture/autoPublishGateService', () => ({
  decide: vi.fn(async () => ({ outcome: 'auto_publish', reason: 'rule', rule: null })),
}));
vi.mock('@/modules/accounting/services/capture/supplierRulesService', () => ({ recordCoding: vi.fn(async () => undefined), getRule: vi.fn(async () => null) }));
vi.mock('@/modules/accounting/services/capture/captureDeduplicationService', async (orig) => ({
  ...await orig<typeof import('@/modules/accounting/services/capture/captureDeduplicationService')>(), findDuplicate: vi.fn(async () => null),
}));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceWorkflowService', () => ({ performThreeWayMatch: vi.fn(async () => null) }));
vi.mock('@/modules/accounting/services/capture/alertResolutionService', () => ({ resolvePendingAlertForInvoice: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/capture/captureBillLines', () => ({
  planCaptureBillLines: vi.fn(async () => ({ lines: [] })),
  insertCaptureBillLines: vi.fn(async () => { order.push('insertLines'); return SLIP; }),
}));
vi.mock('@/modules/accounting/services/gl/approvalUnattended', () => ({
  unattendedBillStatus: vi.fn(async () => ({ status: 'draft', gated: true })),
  raiseUnattendedApproval: vi.fn(async () => { order.push('raiseApproval'); return { id: 'req-1' }; }),
}));
vi.mock('@/modules/accounting/services/capture/capturePostFollowUps', () => ({
  runCapturePostFollowUps: vi.fn(async () => { order.push('attach'); return { provisionalAttach: attachOut.current, threeWayMatch: null }; }),
}));
vi.mock('@/modules/accounting/services/capture/provisionalAttachSettle', () => ({
  attachEvidenceAndSettleApproved: vi.fn(async () => { order.push('attach'); return attachOut.current; }),
}));
vi.mock('@/modules/accounting/services/capture/captureRowLock', async (orig) => ({
  ...await orig<typeof import('@/modules/accounting/services/capture/captureRowLock')>(),
  lockCapturedDocumentForUpdate: vi.fn(async () => ({ id: 'doc', status: 'extracted', extracted_data: { vendorName: 'ACME', lineItems: [] } })),
  lockPostableCaptureEventIds: vi.fn(async () => []),
  claimCapturedDocumentForPosting: vi.fn(async () => null),
  markCaptureEventsPosted: vi.fn(async () => undefined),
}));

import { runCapturePostFollowUps } from '@/modules/accounting/services/capture/capturePostFollowUps';
import { attachEvidenceAndSettleApproved } from '@/modules/accounting/services/capture/provisionalAttachSettle';
import capturePost from '../../../pages/api/accounting/capture/[id]/post';
import pipeline from '../../../pages/api/accounting/ai-invoice-pipeline';

const EVENT_ID = 'dddddddd-0000-0000-0000-dddddddddddd';
const DOC_ID = 'cccccccc-0000-0000-0000-cccccccccccc';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const res = () => ({ setHeader: vi.fn() } as unknown as NextApiResponse<any>);

beforeEach(() => {
  order.length = 0;
  attachOut.current = { attachedJeId: null, bankTxId: null };
  vi.clearAllMocks();
  sqlMock.mockImplementation(((strings: TemplateStringsArray) => {
    const text = Array.isArray(strings) ? strings.join('') : String(strings);
    if (text.includes('FROM capture_events')) {
      return Promise.resolve([{ event_id: EVENT_ID, event_status: 'extracted', captured_document_id: DOC_ID, extracted_data: { vendorName: 'ACME' } }]);
    }
    if (text.includes('UPDATE captured_documents') && text.includes('posted_at IS NULL')) return Promise.resolve([{ id: DOC_ID }]);
    if (text.includes('FROM suppliers')) return Promise.resolve([{ id: 'ffffffff-0000-0000-0000-ffffffffffff', name: 'ACME', vat_number: null }]);
    if (text.includes('INSERT INTO supplier_invoices')) return Promise.resolve([{ id: 'inv-1', invoice_number: 'INV-1', status: 'draft' }]);
    return Promise.resolve([]);
  }) as never);
});

describe('a gated capture bill: the approval request is raised after the attach, which gets the slip plan', () => {
  it('capture/[id]/post', async () => {
    await capturePost({ method: 'POST', companyId: 'co', user: { id: 'u' }, query: { id: EVENT_ID }, body: {} } as never, res());
    expect(order).toEqual(['insertLines', 'attach', 'raiseApproval']);
    expect(vi.mocked(runCapturePostFollowUps).mock.calls[0]![0]).toMatchObject({ slip: SLIP });
  });

  it('ai-invoice-pipeline', async () => {
    await pipeline({ method: 'POST', companyId: 'co', user: { id: 'u' }, body: { documentId: DOC_ID } } as never, res());
    expect(order).toEqual(['insertLines', 'attach', 'raiseApproval']);
    expect(vi.mocked(attachEvidenceAndSettleApproved).mock.calls[0]![0]).toMatchObject({ slip: SLIP });
  });
});

