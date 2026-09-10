/**
 * capture/[id]/post — the stored duplicate_fingerprint must be the canonical one.
 *
 * This route was the THIRD producer of `supplier_invoices.duplicate_fingerprint`
 * and the only one that did not call `computeFingerprint`: it built the string
 * inside the INSERT, casting the JS total bound as a parameter to text. That
 * renders `115`, while the NUMERIC(15,2) column — and therefore
 * `computeFingerprint`, and therefore migration 670's backfill — renders
 * `115.00`. Every bill captured through this route stored a key the exact-match
 * step of `findDuplicate` could never produce, so the same invoice could be
 * captured and posted again with a second accrual against the payable control
 * account.
 *
 * The census that missed it looked for callers of `computeFingerprint`, which by
 * construction cannot find code that builds the value itself. This file pins the
 * route's own INSERT instead.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/auth', () => ({
  withAuth: (fn: unknown) => fn,
  withWriteAccess: (fn: unknown) => fn,
}));
// The capture posting routes now read the event through
// `captureEventLock.lockCaptureEventForPosting`, which takes a `FOR UPDATE`
// row lock and refuses to run outside a request transaction. These tests drive
// the handler directly, with no `withAuth`, so stand in a client whose only job
// is to accept the `SET LOCAL lock_timeout`. The SELECT itself still reaches
// sqlMock, so the stubbing below is unchanged.
vi.mock('@/lib/als', () => ({
  als: { getStore: () => ({ client: { query: async () => undefined } }) },
  assertTxUsable: () => undefined,
}));

vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/apiResponse', () => ({
  ErrorCode: { CONFLICT: 'CONFLICT' },
  apiResponse: {
    success: vi.fn((_res: unknown, data: unknown) => ({ kind: 'success', data })),
    badRequest: vi.fn((_res: unknown, error: string) => ({ kind: 'badRequest', error })),
    notFound: vi.fn((_res: unknown, entity: string) => ({ kind: 'notFound', entity })),
    error: vi.fn(() => ({ kind: 'error' })),
    internalError: vi.fn(() => ({ kind: 'internalError' })),
    methodNotAllowed: vi.fn(() => ({ kind: 'methodNotAllowed' })),
  },
}));

const { sqlMock } = vi.hoisted(() => ({
  sqlMock: Object.assign(vi.fn(), { transaction: vi.fn(), unsafe: vi.fn((s: string) => s) }),
}));
vi.mock('@/lib/neon', () => ({
  sql: sqlMock,
  withTransaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(sqlMock)),
  fmtDate: (d: unknown) => String(d),
}));

const INVOICE_INPUT = {
  invoiceNumber: 'INV-1',
  invoiceDate: '2026-08-13',
  dueDate: '2026-09-12',
  totalAmount: 115,
  taxAmount: 15,
  taxRate: 15,
  paymentTerms: 'net30',
  reference: null,
};

vi.mock('@/modules/accounting/services/core/aiInvoicePipelineService', () => ({
  validatePipelineInput: vi.fn(() => ({ valid: true, errors: [], warnings: [] })),
  matchSupplierFromExtraction: vi.fn(() => ({
    supplierId: 'ffffffff-0000-0000-0000-ffffffffffff', supplierName: 'ACME', confidence: 0.99,
  })),
  buildInvoiceFromExtraction: vi.fn(() => INVOICE_INPUT),
  determineApprovalRoute: vi.fn(() => 'auto_approve'),
  computePipelineConfidence: vi.fn(() => 0.97),
}));
vi.mock('@/modules/accounting/services/capture/autoPublishGateService', () => ({
  decide: vi.fn(async () => ({ outcome: 'auto_publish', reason: 'rule', rule: null })),
}));
vi.mock('@/modules/accounting/services/capture/supplierRulesService', () => ({
  recordCoding: vi.fn(async () => undefined),
}));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceWorkflowService', () => ({
  performThreeWayMatch: vi.fn(async () => null),
}));
vi.mock('@/modules/accounting/services/capture/evidenceAttachmentService', () => ({
  attachEvidenceToProvisional: vi.fn(async () => ({ attachedJeId: null, bankTxId: null })),
}));
vi.mock('@/modules/accounting/services/capture/alertResolutionService', () => ({
  resolvePendingAlertForInvoice: vi.fn(async () => undefined),
}));

// The helper stays REAL: it is the canonical form the assertion compares against.
import { computeFingerprint } from '@/modules/accounting/services/capture/captureDeduplicationService';
import { decide } from '@/modules/accounting/services/capture/autoPublishGateService';
import handler from '../../../pages/api/accounting/capture/[id]/post';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
const USER_ID = 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb';
const EVENT_ID = 'dddddddd-0000-0000-0000-dddddddddddd';
const DOC_ID = 'cccccccc-0000-0000-0000-cccccccccccc';
const SUPPLIER_ID = 'ffffffff-0000-0000-0000-ffffffffffff';
/** What `suppliers.vat_number` holds — the source every other producer reads. */
const SUPPLIER_VAT = '4150165685';
/** What the OCR read off the page — deliberately different. */
const DOCUMENT_VAT = '4999999999';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const res = () => ({} as NextApiResponse<any>);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const req = (): any => ({
  method: 'POST', companyId: COMPANY_ID, user: { id: USER_ID },
  query: { id: EVENT_ID }, body: {},
});

function stubDb(supplierVat: string | null = SUPPLIER_VAT) {
  sqlMock.mockImplementation(((strings: TemplateStringsArray) => {
    const text = Array.isArray(strings) ? strings.join('') : String(strings);
    if (text.includes('FROM capture_events')) {
      return Promise.resolve([{
        event_id: EVENT_ID, event_status: 'pending', captured_document_id: DOC_ID,
        extracted_data: { vendorName: 'ACME', vendorVatNumber: DOCUMENT_VAT },
      }]);
    }
    if (text.includes('FROM suppliers')) {
      return Promise.resolve([{ id: SUPPLIER_ID, name: 'ACME', vat_number: supplierVat }]);
    }
    if (text.includes('INSERT INTO supplier_invoices')) {
      return Promise.resolve([{ id: 'inv-1', invoice_number: 'INV-1', status: 'approved' }]);
    }
    return Promise.resolve([]);
  }) as never);
}

function insertCall(): unknown[] {
  const call = sqlMock.mock.calls.find((c) => {
    const strings = c[0] as unknown as string[];
    return Array.isArray(strings) && strings.join('').includes('INSERT INTO supplier_invoices');
  });
  expect(call, 'the route must INSERT INTO supplier_invoices').toBeDefined();
  return call as unknown[];
}

beforeEach(() => {
  vi.clearAllMocks();
  stubDb();
});

describe('capture post — duplicate_fingerprint', () => {
  it('binds exactly what computeFingerprint produces', async () => {
    await handler(req(), res());
    const bound = insertCall().slice(1);
    const canonical = computeFingerprint(SUPPLIER_VAT, INVOICE_INPUT.invoiceNumber, INVOICE_INPUT.totalAmount);
    expect(canonical).toBe('4150165685|inv-1|115.00');
    expect(bound).toContain(canonical);
  });

  it('takes the VAT segment from the supplier row, not the OCR extraction', async () => {
    // Same helper, different argument, different string. Seven other producers
    // and migration 670 read `suppliers.vat_number`; this route read
    // `extracted.vendorVatNumber`, so 670 rewrote its rows to a value the next
    // capture of the same bill would never compute and the exact-match step
    // found nothing.
    await handler(req(), res());
    const bound = insertCall().slice(1);
    expect(bound).toContain(`${SUPPLIER_VAT}|inv-1|115.00`);
    expect(bound).not.toContain(`${DOCUMENT_VAT}|inv-1|115.00`);
  });

  it("uses 'no-vat' when the supplier record has none, even if the document does", async () => {
    // 670 writes coalesce(s.vat_number, 'no-vat'); the route must converge on
    // the same string or the backfill and the capture path disagree again.
    stubDb(null);
    await handler(req(), res());
    const bound = insertCall().slice(1);
    expect(bound).toContain('no-vat|inv-1|115.00');
    expect(bound).not.toContain(`${DOCUMENT_VAT}|inv-1|115.00`);
  });

  it('gives the duplicate gate the same VAT it stores', async () => {
    // The gate's lookup key and the stored key must be the same string, or the
    // guard misses its own writes.
    await handler(req(), res());
    const gateArg = vi.mocked(decide).mock.calls[0]![0];
    expect(gateArg.vatNumber).toBe(SUPPLIER_VAT);
    const bound = insertCall().slice(1);
    expect(bound).toContain(
      computeFingerprint(gateArg.vatNumber, gateArg.invoiceNumber, gateArg.totalAmount),
    );
  });

  it('does not build the fingerprint in SQL from the bound total', async () => {
    // The defect's shape: an inline `coalesce(… || $n::text …)` renders the JS
    // number, so the stored key ends `|115` and the lookup's `|115.00` misses.
    await handler(req(), res());
    const call = insertCall();
    const text = (call[0] as unknown as string[]).join('?');
    expect(text).not.toContain("'no-vat'");
    expect(call.slice(1).some((v) => typeof v === 'string' && v.endsWith('|115'))).toBe(false);
  });
});
