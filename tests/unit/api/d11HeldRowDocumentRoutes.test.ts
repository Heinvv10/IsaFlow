/**
 * D11: a held row answers 503 + Retry-After on the capture, payment-link, payroll, approval, recurring-journal, VAT and
 * journal routes. Each used to answer 409 (capture post, approval-requests, recurring-journals-action, VAT) or 400
 * (receipt-to-journal, ai-invoice-pipeline, document-capture-action, payment-gateway, pay-now, payment-link revoke,
 * payroll approve / reopen / calculate, journal-entries-action). The other direction is pinned too: a state conflict or
 * refusal on the same route keeps its status. The bank routes are in d11HeldRowBankRoutes.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
// Step 2's bank gates read Postgres; stubbed open here, proven in tests/integration/bank-controls-*.int.test.ts.
vi.mock('@/modules/accounting/services/bank/bankLineImporterGate', async () => (await import('../helpers/bankControlGateMocks')).importerGateOpen());
vi.mock('@/modules/accounting/services/bank/bankReversalGate', async () => (await import('../helpers/bankControlGateMocks')).reversalGateOpen());
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({
  withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h, withVatVendor: (h: unknown) => h,
  withRole: () => (h: unknown) => h, withCsrf: (h: unknown) => h,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/rateLimit', () => ({ checkAiRateLimit: vi.fn().mockResolvedValue(true) }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(), withSavepoint: (_name: string, fn: () => unknown) => fn(),
}));
vi.mock('@/modules/accounting/services/capture/captureRowLock', async (orig) => ({
  ...(await orig<object>()), lockCaptureEventForPosting: vi.fn(), lockCapturedDocumentForUpdate: vi.fn(),
}));
vi.mock('@/modules/accounting/services/capture/captureLifecycleGate', () => ({ releaseClaimForLifecycleAction: vi.fn() }));
vi.mock('@/modules/accounting/services/core/paymentGatewayPortalService', async (orig) => ({
  ...(await orig<object>()), enableOnlinePayment: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/standingPaymentLink', async (orig) => ({
  ...(await orig<object>()), ensureStandingLink: vi.fn(), revokeStandingLink: vi.fn(), portalAppUrl: () => 'https://app.test',
}));
vi.mock('@/modules/accounting/services/payroll/payrollApprovalService', async (orig) => ({
  ...(await orig<object>()), approvePayrollRun: vi.fn(),
}));
vi.mock('@/modules/accounting/services/payroll/payrollRunLock', async (orig) => ({
  ...(await orig<object>()), reopenPayrollRun: vi.fn(),
}));
vi.mock('@/modules/accounting/services/payroll/payrollRunService', () => ({ calculatePayrollRun: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/approvalService', async (orig) => ({ ...(await orig<object>()), decideRequest: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/recurringJournalService', async (orig) => ({
  ...(await orig<object>()), updateRecurringJournalStatus: vi.fn(), runRecurringJournal: vi.fn(),
}));
vi.mock('@/modules/accounting/services/reports/vatAdjustmentService', async (orig) => ({
  ...(await orig<object>()), approveVATAdjustment: vi.fn(), cancelVATAdjustment: vi.fn(),
}));
vi.mock('@/modules/accounting/services/reports/vatPeriodLockService', async (orig) => ({
  ...(await orig<object>()), lockVatPeriod: vi.fn(), unlockVatPeriod: vi.fn(), getVatPeriodLock: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/modules/accounting/services/reports/vatPeriodLockFigures', () => ({
  computeVatLockFigures: vi.fn().mockResolvedValue({ figures: {}, report: { rateCheck: { ties: true } } }),
}));
vi.mock('@/modules/accounting/services/reports/vatGateOverrideService', async (orig) => ({
  ...(await orig<object>()), assertVatGateClear: vi.fn().mockResolvedValue({ overridden: false }),
}));
// D12 round 2: the reverse verb first refuses cash a completed bank reconciliation holds (its own integration test);
// here no statement line is matched to the journal.
vi.mock('@/modules/accounting/services/bank/reconciledCash', () => ({ refuseJournalCashOfCompletedReconciliation: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  postJournalEntry: vi.fn(), reverseJournalEntry: vi.fn(),
}));

import { lockCaptureEventForPosting, lockCapturedDocumentForUpdate, CaptureRowLockTimeoutError } from '@/modules/accounting/services/capture/captureRowLock';
import { sql } from '@/lib/neon';
import { releaseClaimForLifecycleAction } from '@/modules/accounting/services/capture/captureLifecycleGate';
import { enableOnlinePayment, InvoiceNotApprovedError } from '@/modules/accounting/services/core/paymentGatewayPortalService';
import { ensureStandingLink, revokeStandingLink } from '@/modules/accounting/services/ar/standingPaymentLink';
import { CustomerInvoiceLockTimeoutError } from '@/modules/accounting/services/ar/customerInvoiceLock';
import { approvePayrollRun, PayrollApprovalConflictError } from '@/modules/accounting/services/payroll/payrollApprovalService';
import { reopenPayrollRun, PayrollRunReopenRefusedError } from '@/modules/accounting/services/payroll/payrollRunLock';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { PayrollLoanLockTimeoutError, PayrollRunJournalPostedError } from '@/modules/accounting/services/payroll/payrollRunLoanApplication';
import { decideRequest } from '@/modules/accounting/services/gl/approvalService';
import { ApprovalRequestLockTimeoutError, } from '@/modules/accounting/services/gl/approvalRequestLock';
import { ApprovalDocumentChangedError } from '@/modules/accounting/services/gl/approvalDecideDocument';
import { updateRecurringJournalStatus, runRecurringJournal } from '@/modules/accounting/services/gl/recurringJournalService';
import { RecurringJournalLockTimeoutError, RecurringJournalRequestError } from '@/modules/accounting/services/gl/recurringJournalGuards';
import { approveVATAdjustment, VatAdjustmentRefusal } from '@/modules/accounting/services/reports/vatAdjustmentService';
import { lockVatPeriod, unlockVatPeriod } from '@/modules/accounting/services/reports/vatPeriodLockService';
import { VatLockTimeoutError } from '@/modules/accounting/services/gl/journalVatLockGuard';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { PayrollRunBusyError, PayrollJournalReversalRefusedError } from '@/modules/accounting/services/payroll/payrollJournalReversalGuard';
import capturePost from '../../../pages/api/accounting/capture/[id]/post';
import capturePostExpense from '../../../pages/api/accounting/capture/[id]/post-expense';
import receiptToJournal from '../../../pages/api/accounting/receipt-to-journal';
import aiInvoicePipeline from '../../../pages/api/accounting/ai-invoice-pipeline';
import documentCaptureAction from '../../../pages/api/accounting/document-capture-action';
import paymentGateway from '../../../pages/api/accounting/payment-gateway';
import payNow from '../../../pages/api/accounting/customer-invoices/[id]/pay-now';
import paymentLinkRevoke from '../../../pages/api/accounting/customer-invoices/[id]/payment-link/revoke';
import payrollApprove from '../../../pages/api/payroll/runs/[id]/approve';
import payrollReopen from '../../../pages/api/payroll/runs/[id]/reopen';
import payrollCalculate from '../../../pages/api/payroll/runs/[id]/calculate';
import approvalRequests from '../../../pages/api/accounting/approval-requests';
import recurringJournals from '../../../pages/api/accounting/recurring-journals-action';
import vatAdjustments from '../../../pages/api/accounting/vat-adjustments-action';
import vatPeriodLocks from '../../../pages/api/accounting/vat-period-locks';
import journalEntriesAction from '../../../pages/api/accounting/journal-entries-action';

const ID = '66666666-6666-4666-8666-666666666666';
type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;

function call(handler: Handler, body: unknown, query: Record<string, string> = {}) {
  const req = { method: 'POST', query, body, companyId: '11111111-1111-4111-8111-111111111111', companyRole: 'owner',
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

type Res = Awaited<ReturnType<typeof call>>;
function expectHeld(res: Res) {
  expect(res.statusCode).toBe(503);
  expect(res.headers['Retry-After']).toBe('2');
}
function expectStatus(res: Res, status: number) {
  expect(res.statusCode).toBe(status);
  expect(res.headers['Retry-After']).toBeUndefined();
}

beforeEach(() => { vi.clearAllMocks(); });

describe('D11 capture routes: a held capture row -> 503 + Retry-After', () => {
  it('capture/[id]/post (was 409)', async () => {
    vi.mocked(lockCaptureEventForPosting).mockRejectedValueOnce(new CaptureRowLockTimeoutError(ID));
    expectHeld(await call(capturePost, {}, { id: ID }));
  });
  it('capture/[id]/post-expense (was 409)', async () => {
    vi.mocked(lockCaptureEventForPosting).mockRejectedValueOnce(new CaptureRowLockTimeoutError(ID));
    expectHeld(await call(capturePostExpense, {}, { id: ID }));
  });
  it('capture/[id]/post: a missing event keeps 404', async () => {
    vi.mocked(lockCaptureEventForPosting).mockResolvedValueOnce(null as never);
    expectStatus(await call(capturePost, {}, { id: ID }), 404);
  });
  it('receipt-to-journal (was 400)', async () => {
    vi.mocked(lockCapturedDocumentForUpdate).mockRejectedValueOnce(new CaptureRowLockTimeoutError(ID));
    expectHeld(await call(receiptToJournal, { documentId: ID }));
  });
  it('ai-invoice-pipeline (was 400)', async () => {
    vi.mocked(lockCapturedDocumentForUpdate).mockRejectedValueOnce(new CaptureRowLockTimeoutError(ID));
    expectHeld(await call(aiInvoicePipeline, { documentId: ID }));
  });
  it('receipt-to-journal: a missing document keeps 404', async () => {
    vi.mocked(lockCapturedDocumentForUpdate).mockResolvedValueOnce(null as never);
    expectStatus(await call(receiptToJournal, { documentId: ID }), 404);
  });
  it('document-capture-action (was 400)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{ id: ID }] as never);
    vi.mocked(releaseClaimForLifecycleAction).mockRejectedValueOnce(new CaptureRowLockTimeoutError(ID));
    expectHeld(await call(documentCaptureAction, { id: ID, action: 'confirm' }));
  });
  it('document-capture-action: a refused (posted) document keeps 4xx, no Retry-After', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{ id: ID }] as never);
    vi.mocked(releaseClaimForLifecycleAction).mockResolvedValueOnce('refused');
    const res = await call(documentCaptureAction, { id: ID, action: 'confirm' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.headers['Retry-After']).toBeUndefined();
  });
});

describe('D11 customer-invoice lock routes: a held invoice -> 503 + Retry-After (was 400)', () => {
  const held = () => new CustomerInvoiceLockTimeoutError('Invoice INV-1');
  it('payment-gateway', async () => {
    vi.mocked(enableOnlinePayment).mockRejectedValueOnce(held());
    expectHeld(await call(paymentGateway, { invoiceId: ID, action: 'enable' }));
  });
  it('payment-gateway: an unapproved invoice keeps 400', async () => {
    vi.mocked(enableOnlinePayment).mockRejectedValueOnce(new InvoiceNotApprovedError('draft'));
    expectStatus(await call(paymentGateway, { invoiceId: ID, action: 'enable' }), 400);
  });
  it('customer-invoices/[id]/pay-now', async () => {
    vi.mocked(ensureStandingLink).mockRejectedValueOnce(held());
    expectHeld(await call(payNow, {}, { id: ID }));
  });
  it('customer-invoices/[id]/pay-now: an unapproved invoice keeps 400', async () => {
    vi.mocked(ensureStandingLink).mockResolvedValueOnce({ ok: false, reason: 'invoice_unapproved' } as never);
    expectStatus(await call(payNow, {}, { id: ID }), 400);
  });
  it('customer-invoices/[id]/payment-link/revoke', async () => {
    vi.mocked(revokeStandingLink).mockRejectedValueOnce(held());
    expectHeld(await call(paymentLinkRevoke, {}, { id: ID }));
  });
});

describe('D11 payroll routes: a held run or loan row -> 503 + Retry-After (was 400)', () => {
  const held = () => new PayrollLoanLockTimeoutError(ID);
  it('approve', async () => {
    vi.mocked(approvePayrollRun).mockRejectedValueOnce(held());
    expectHeld(await call(payrollApprove, { expectedPlanHash: 'h' }, { id: ID }));
  });
  it('approve: a state conflict keeps 409', async () => {
    vi.mocked(approvePayrollRun).mockRejectedValueOnce(new PayrollApprovalConflictError('changed'));
    expectStatus(await call(payrollApprove, { expectedPlanHash: 'h' }, { id: ID }), 409);
  });
  it('reopen', async () => {
    vi.mocked(reopenPayrollRun).mockRejectedValueOnce(held());
    expectHeld(await call(payrollReopen, { reason: 'because' }, { id: ID }));
  });
  it('reopen: a refusal keeps 400', async () => {
    vi.mocked(reopenPayrollRun).mockRejectedValueOnce(new PayrollRunReopenRefusedError('paid'));
    expectStatus(await call(payrollReopen, { reason: 'because' }, { id: ID }), 400);
  });
  it('calculate', async () => {
    vi.mocked(calculatePayrollRun).mockRejectedValueOnce(held());
    expectHeld(await call(payrollCalculate, {}, { id: ID }));
  });
  it('calculate: a posted-journal refusal keeps 400', async () => {
    vi.mocked(calculatePayrollRun).mockRejectedValueOnce(new PayrollRunJournalPostedError(ID));
    expectStatus(await call(payrollCalculate, {}, { id: ID }), 400);
  });
});

describe('D11 approval-requests, recurring-journals-action, journal-entries-action', () => {
  const decide = { action: 'approve', requestId: ID };
  it('approval-requests: a held request row -> 503 (was 409)', async () => {
    vi.mocked(decideRequest).mockRejectedValueOnce(new ApprovalRequestLockTimeoutError(ID));
    expectHeld(await call(approvalRequests, decide));
  });
  it('approval-requests: a document changed since the request keeps 409', async () => {
    vi.mocked(decideRequest).mockRejectedValueOnce(new ApprovalDocumentChangedError('changed'));
    expectStatus(await call(approvalRequests, decide), 409);
  });
  it('recurring-journals-action: a held template -> 503 (was 409)', async () => {
    vi.mocked(runRecurringJournal).mockRejectedValueOnce(new RecurringJournalLockTimeoutError(ID));
    expectHeld(await call(recurringJournals, { action: 'generate', id: ID }));
  });
  it('recurring-journals-action: a request refusal keeps 400; a numbering collision keeps 409', async () => {
    vi.mocked(updateRecurringJournalStatus).mockRejectedValueOnce(new RecurringJournalRequestError('bad'));
    expectStatus(await call(recurringJournals, { action: 'pause', id: ID }), 400);
    vi.mocked(updateRecurringJournalStatus).mockRejectedValueOnce(
      Object.assign(new Error('dup'), { code: '23505', constraint: 'uq_gl_je_company_entry_number' }));
    expectStatus(await call(recurringJournals, { action: 'pause', id: ID }), 409);
  });
  it('journal-entries-action: a busy pay run (held run header) -> 503 (was 400)', async () => {
    vi.mocked(reverseJournalEntry).mockRejectedValueOnce(new PayrollRunBusyError(ID));
    expectHeld(await call(journalEntriesAction, { id: ID, action: 'reverse' }));
  });
  it('journal-entries-action: a pay-run STATE refusal keeps 400', async () => {
    vi.mocked(reverseJournalEntry).mockRejectedValueOnce(new PayrollJournalReversalRefusedError('approved run'));
    expectStatus(await call(journalEntriesAction, { id: ID, action: 'reverse' }), 400);
  });
});

describe('D11 VAT routes', () => {
  const lock = { action: 'lock', periodStart: '2026-07-01', periodEnd: '2026-08-31' };
  const unlock = { action: 'unlock', lockId: ID, reason: 'correction' };
  it('vat-adjustments-action: a contended adjustment -> 503 (was 409)', async () => {
    vi.mocked(approveVATAdjustment).mockRejectedValueOnce(new VatAdjustmentRefusal('contended', 'held — retry'));
    expectHeld(await call(vatAdjustments, { action: 'approve', id: ID }));
  });
  it('vat-adjustments-action: a raw 55P03 -> 503 (was 409)', async () => {
    vi.mocked(approveVATAdjustment).mockRejectedValueOnce(Object.assign(new Error('lock'), { code: '55P03' }));
    expectHeld(await call(vatAdjustments, { action: 'approve', id: ID }));
  });
  it('vat-adjustments-action: not_draft keeps 400; an entry-number collision keeps 409', async () => {
    vi.mocked(approveVATAdjustment).mockRejectedValueOnce(new VatAdjustmentRefusal('not_draft', 'already approved'));
    expectStatus(await call(vatAdjustments, { action: 'approve', id: ID }), 400);
    vi.mocked(approveVATAdjustment).mockRejectedValueOnce(
      Object.assign(new Error('dup'), { code: '23505', constraint: 'uq_gl_je_company_entry_number' }));
    expectStatus(await call(vatAdjustments, { action: 'approve', id: ID }), 409);
  });
  it('vat-period-locks lock: the company journal lock held -> 503 (was 409)', async () => {
    vi.mocked(lockVatPeriod).mockRejectedValueOnce(new VatLockTimeoutError());
    expectHeld(await call(vatPeriodLocks, lock));
  });
  it('vat-period-locks unlock: the company journal lock held -> 503 (was 409)', async () => {
    vi.mocked(unlockVatPeriod).mockRejectedValueOnce(new VatLockTimeoutError());
    expectHeld(await call(vatPeriodLocks, unlock));
  });
});
