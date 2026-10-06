/**
 * D11 round 2 (brk-d11 F3): the routes whose catch answered a held row 400 / 500 (a blanket `badRequest`,
 * `badRequestFromError`, `databaseError` or `internalError`) now call `respondIfLockTimeout` first. Per route: a held row
 * (a typed `DocumentNumberLockTimeoutError`, and a raw 40P01 deadlock victim) -> 503 + Retry-After; an ordinary failure
 * keeps the status it had. The mapping itself is pinned in tests/unit/lib/heldRowError.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({
  withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h, withVatVendor: (h: unknown) => h,
  withRole: () => (h: unknown) => h, withCsrf: (h: unknown) => h,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/rateLimit', () => ({ checkAiRateLimit: vi.fn().mockResolvedValue(true), checkRateLimit: vi.fn().mockResolvedValue(true) }));
vi.mock('@/lib/billing/withFlowMeter', () => ({ withFlowMeter: () => (h: unknown) => h }));
vi.mock('@/modules/accounting/services/core/companySettingsService', async (orig) => ({ ...(await orig<object>()), reserveNextDocumentNumber: vi.fn() }));
vi.mock('@/modules/accounting/services/core/companyService', async (orig) => ({ ...(await orig<object>()), reserveNextDocumentNumber: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: (_n: string, fn: () => unknown) => fn(), withTransaction: vi.fn() }));

vi.mock('@/modules/accounting/services/items/adjustmentService', async (orig) => ({ ...(await orig<object>()), createAdjustment: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/bankReconciliationService', async (orig) => ({ ...(await orig<object>()), completeReconciliation: vi.fn(), startReconciliation: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/bankRulesService', async (orig) => ({ ...(await orig<object>()), deleteRule: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/customerInvoiceCreateService', async (orig) => ({ ...(await orig<object>()), createDraftCustomerInvoice: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/customerPaymentService', async (orig) => ({ ...(await orig<object>()), createCustomerPayment: vi.fn(), postCustomerInvoiceToGL: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/salesOrderService', async (orig) => ({ ...(await orig<object>()), confirmSalesOrder: vi.fn() }));
vi.mock('@/modules/accounting/services/reports/drcVatService', async (orig) => ({ ...(await orig<object>()), applyDRCVat: vi.fn() }));
vi.mock('@/modules/accounting/services/expense/expenseClaimService', async (orig) => ({ ...(await orig<object>()), addLine: vi.fn(), approveClaim: vi.fn(), submitClaim: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/journalEntryService', async (orig) => ({ ...(await orig<object>()), createJournalEntry: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/openingBalancePostingService', async (orig) => ({ ...(await orig<object>()), postOpeningBalances: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/recurringInvoiceService', async (orig) => ({ ...(await orig<object>()), createRecurringInvoice: vi.fn(), updateRecurringStatus: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/recurringJournalService', async (orig) => ({ ...(await orig<object>()), createRecurringJournal: vi.fn() }));
vi.mock('@/modules/accounting/services/core/recurringTransactionService', async (orig) => ({ ...(await orig<object>()), createRecurringTemplate: vi.fn() }));
vi.mock('@/modules/accounting/services/reports/sarsEfilingSubmissionService', async (orig) => ({ ...(await orig<object>()), submitVAT201ToSars: vi.fn() }));
vi.mock('@/modules/accounting/services/reports/vat201LedgerFields', async (orig) => ({ ...(await orig<object>()), getLedgerVAT201: vi.fn().mockResolvedValue({}) }));
vi.mock('@/modules/accounting/services/reports/sarsService', async (orig) => ({ ...(await orig<object>()), saveDraftSubmission: vi.fn(), generateEMP201: vi.fn().mockResolvedValue({}) }));
vi.mock('@/modules/accounting/services/core/smartCategorizationService', async (orig) => ({ ...(await orig<object>()), smartCategorizeForAccount: vi.fn() }));
vi.mock('@/modules/accounting/services/reports/vatAdjustmentService', async (orig) => ({ ...(await orig<object>()), createVATAdjustment: vi.fn() }));
vi.mock('@/modules/accounting/services/reports/vatSubmissionService', async (orig) => ({ ...(await orig<object>()), submitVATReturn: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/writeOffService', async (orig) => ({ ...(await orig<object>()), createWriteOff: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/creditNoteService', async (orig) => ({ ...(await orig<object>()), createCreditNote: vi.fn() }));

import { createAdjustment } from '@/modules/accounting/services/items/adjustmentService';
import { completeReconciliation, startReconciliation } from '@/modules/accounting/services/bank/bankReconciliationService';
import { deleteRule } from '@/modules/accounting/services/bank/bankRulesService';
import { createDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { createCustomerPayment, postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentService';
import { confirmSalesOrder } from '@/modules/accounting/services/ar/salesOrderService';
import { applyDRCVat } from '@/modules/accounting/services/reports/drcVatService';
import { addLine, approveClaim, submitClaim } from '@/modules/accounting/services/expense/expenseClaimService';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { postOpeningBalances } from '@/modules/accounting/services/gl/openingBalancePostingService';
import { createRecurringInvoice, updateRecurringStatus } from '@/modules/accounting/services/ar/recurringInvoiceService';
import { createRecurringJournal } from '@/modules/accounting/services/gl/recurringJournalService';
import { createRecurringTemplate } from '@/modules/accounting/services/core/recurringTransactionService';
import { submitVAT201ToSars } from '@/modules/accounting/services/reports/sarsEfilingSubmissionService';
import { saveDraftSubmission } from '@/modules/accounting/services/reports/sarsService';
import { smartCategorizeForAccount } from '@/modules/accounting/services/core/smartCategorizationService';
import { createVATAdjustment } from '@/modules/accounting/services/reports/vatAdjustmentService';
import { submitVATReturn } from '@/modules/accounting/services/reports/vatSubmissionService';
import { createWriteOff } from '@/modules/accounting/services/ar/writeOffService';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import hCreditNotes from '../../../pages/api/accounting/credit-notes';
import hSupplierCreditNotes from '../../../pages/api/accounting/supplier-credit-notes';
import { sql, withTransaction } from '@/lib/neon';
import { reserveNextDocumentNumber as reserveSiv } from '@/modules/accounting/services/core/companyService';
import { DocumentNumberLockTimeoutError, reserveNextDocumentNumber } from '@/modules/accounting/services/core/companySettingsService';
import hSupplierInvoices from '../../../pages/api/accounting/supplier-invoices';
import hSupplierReturns from '../../../pages/api/accounting/supplier-returns';
import hBankTransfers from '../../../pages/api/accounting/bank-transfers';
import hRecurringInvoices2 from '../../../pages/api/accounting/recurring-invoices';
import hRecurringJournals2 from '../../../pages/api/accounting/recurring-journals';
import hAdjustments from '../../../pages/api/accounting/adjustments';
import hBankReconciliationsAction from '../../../pages/api/accounting/bank-reconciliations-action';
import hBankReconciliations from '../../../pages/api/accounting/bank-reconciliations';
import hBankRulesAction from '../../../pages/api/accounting/bank-rules-action';
import hCustomerInvoicesCreate from '../../../pages/api/accounting/customer-invoices-create';
import hCustomerInvoicesGl from '../../../pages/api/accounting/customer-invoices-gl';
import hCustomerPayments from '../../../pages/api/accounting/customer-payments';
import hCustomerSalesOrdersAction from '../../../pages/api/accounting/customer-sales-orders-action';
import hDrcVat from '../../../pages/api/accounting/drc-vat';
import hExpenseClaimsIdApprove from '../../../pages/api/accounting/expense-claims/[id]/approve';
import hExpenseClaimsIdSubmit from '../../../pages/api/accounting/expense-claims/[id]/submit';
import hExpenseClaimsMileageTrip from '../../../pages/api/accounting/expense-claims/mileage-trip';
import hJournalEntries from '../../../pages/api/accounting/journal-entries';
import hOpeningBalances from '../../../pages/api/accounting/opening-balances';
import hRecurringInvoicesAction from '../../../pages/api/accounting/recurring-invoices-action';
import hRecurringInvoices from '../../../pages/api/accounting/recurring-invoices';
import hRecurringJournals from '../../../pages/api/accounting/recurring-journals';
import hRecurringTransactions from '../../../pages/api/accounting/recurring-transactions';
import hSarsEfilingSubmit from '../../../pages/api/accounting/sars/efiling-submit';
import hSarsSarsEmp201 from '../../../pages/api/accounting/sars/sars-emp201';
import hSarsSarsVat201 from '../../../pages/api/accounting/sars/sars-vat201';
import hSmartCategorize from '../../../pages/api/accounting/smart-categorize';
import hVatAdjustments from '../../../pages/api/accounting/vat-adjustments';
import hVatReturnsIndex from '../../../pages/api/accounting/vat-returns/index';
import hWriteOffs from '../../../pages/api/accounting/write-offs';

const ID = '66666666-6666-4666-8666-666666666666';
type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;
function call(handler: Handler, method: string, body: unknown, query: Record<string, string>) {
  const req = { method, query, body, headers: {}, socket: {}, companyId: '11111111-1111-4111-8111-111111111111', companyRole: 'owner',
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
const heldTyped = () => new DocumentNumberLockTimeoutError('supplier_invoice');
const deadlock = () => Object.assign(new Error('deadlock detected'), { code: '40P01' });
// A document or journal number held past the number lock's 5 s bound (migration 858) surfaces as a raw 55P03.
const numberLockTimeout = () => Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });

type Row = [string, Handler, ReturnType<typeof vi.fn>, string, Record<string, unknown>, Record<string, string>];
const idify = (v: unknown): unknown => JSON.parse(JSON.stringify(v).replace(/"ID"/g, `"${ID}"`));
const rows: Row[] = [
  ['adjustments', hAdjustments as Handler, vi.mocked(createAdjustment) as never, 'POST', idify({}) as Record<string, unknown>, idify({}) as Record<string, string>],
  ['bank-reconciliations-action', hBankReconciliationsAction as Handler, vi.mocked(completeReconciliation) as never, 'POST', idify({"action": "complete", "reconciliationId": "ID"}) as Record<string, unknown>, idify({}) as Record<string, string>],
  ['bank-reconciliations', hBankReconciliations as Handler, vi.mocked(startReconciliation) as never, 'POST', idify({"bankAccountId": "ID", "statementDate": "2026-09-30", "statementBalance": 0}) as Record<string, unknown>, idify({}) as Record<string, string>],
  ['bank-rules-action', hBankRulesAction as Handler, vi.mocked(deleteRule) as never, 'POST', idify({"action": "delete", "id": "ID"}) as Record<string, unknown>, idify({}) as Record<string, string>],
  ['customer-invoices-create', hCustomerInvoicesCreate as Handler, vi.mocked(createDraftCustomerInvoice) as never, 'POST', idify({"clientId": "ID", "invoiceDate": "2026-09-01", "dueDate": "2026-09-30", "items": [{"description": "x", "quantity": 1, "unitPrice": 1}]}) as Record<string, unknown>, idify({}) as Record<string, string>],
  ['customer-invoices-gl', hCustomerInvoicesGl as Handler, vi.mocked(postCustomerInvoiceToGL) as never, 'POST', idify({"invoiceId": "ID"}) as Record<string, unknown>, idify({}) as Record<string, string>],
  ['customer-payments', hCustomerPayments as Handler, vi.mocked(createCustomerPayment) as never, 'POST', idify({"clientId": "ID", "paymentDate": "2026-09-01", "totalAmount": 10, "allocations": [{"invoiceId": "ID", "amount": 10}]}) as Record<string, unknown>, idify({}) as Record<string, string>],
  ['customer-sales-orders-action', hCustomerSalesOrdersAction as Handler, vi.mocked(confirmSalesOrder) as never, 'POST', idify({"action": "confirm", "id": "ID"}) as Record<string, unknown>, idify({}) as Record<string, string>],
  ['drc-vat', hDrcVat as Handler, vi.mocked(applyDRCVat) as never, 'POST', idify({"supplierInvoiceId": "ID"}) as Record<string, unknown>, idify({}) as Record<string, string>],
  ['expense-claims/[id]/approve', hExpenseClaimsIdApprove as Handler, vi.mocked(approveClaim) as never, 'POST', idify({"decision": "approve"}) as Record<string, unknown>, idify({"id": "ID"}) as Record<string, string>],
  ['expense-claims/[id]/submit', hExpenseClaimsIdSubmit as Handler, vi.mocked(submitClaim) as never, 'POST', idify({}) as Record<string, unknown>, idify({"id": "ID"}) as Record<string, string>],
  ['expense-claims/mileage-trip', hExpenseClaimsMileageTrip as Handler, vi.mocked(addLine) as never, 'POST', idify({"claimId": "ID", "km": 10}) as Record<string, unknown>, idify({}) as Record<string, string>],
  ['journal-entries', hJournalEntries as Handler, vi.mocked(createJournalEntry) as never, 'POST', idify({"entryDate": "2026-09-01", "lines": [{}]}) as Record<string, unknown>, idify({}) as Record<string, string>],
  ['opening-balances', hOpeningBalances as Handler, vi.mocked(postOpeningBalances) as never, 'POST', idify({"balances": []}) as Record<string, unknown>, idify({}) as Record<string, string>],
  ['recurring-invoices-action', hRecurringInvoicesAction as Handler, vi.mocked(updateRecurringStatus) as never, 'POST', idify({"action": "pause", "id": "ID"}) as Record<string, unknown>, idify({}) as Record<string, string>],
  ['recurring-invoices', hRecurringInvoices as Handler, vi.mocked(createRecurringInvoice) as never, 'POST', idify({}) as Record<string, unknown>, idify({}) as Record<string, string>],
  ['recurring-journals', hRecurringJournals as Handler, vi.mocked(createRecurringJournal) as never, 'POST', idify({}) as Record<string, unknown>, idify({}) as Record<string, string>],
  ['recurring-transactions', hRecurringTransactions as Handler, vi.mocked(createRecurringTemplate) as never, 'POST', idify({"name": "x", "entityType": "supplier_invoice", "templateData": {}, "frequency": "monthly", "nextRunDate": "2026-10-01"}) as Record<string, unknown>, idify({}) as Record<string, string>],
  ['sars/efiling-submit', hSarsEfilingSubmit as Handler, vi.mocked(submitVAT201ToSars) as never, 'POST', idify({"submissionId": "ID"}) as Record<string, unknown>, idify({}) as Record<string, string>],
  ['sars/sars-emp201', hSarsSarsEmp201 as Handler, vi.mocked(saveDraftSubmission) as never, 'POST', idify({"periodStart": "2026-08-01", "periodEnd": "2026-08-31"}) as Record<string, unknown>, idify({}) as Record<string, string>],
  ['sars/sars-vat201', hSarsSarsVat201 as Handler, vi.mocked(saveDraftSubmission) as never, 'POST', idify({"periodStart": "2026-08-01", "periodEnd": "2026-08-31"}) as Record<string, unknown>, idify({}) as Record<string, string>],
  ['smart-categorize', hSmartCategorize as Handler, vi.mocked(smartCategorizeForAccount) as never, 'POST', idify({"action": "categorize", "bankAccountId": "ID"}) as Record<string, unknown>, idify({}) as Record<string, string>],
  ['vat-adjustments', hVatAdjustments as Handler, vi.mocked(createVATAdjustment) as never, 'POST', idify({}) as Record<string, unknown>, idify({}) as Record<string, string>],
  ['vat-returns/index', hVatReturnsIndex as Handler, vi.mocked(submitVATReturn) as never, 'POST', idify({"periodStart": "2026-08-01", "periodEnd": "2026-08-31"}) as Record<string, unknown>, idify({}) as Record<string, string>],
  ['write-offs', hWriteOffs as Handler, vi.mocked(createWriteOff) as never, 'POST', idify({}) as Record<string, unknown>, idify({}) as Record<string, string>],
  ['credit-notes', hCreditNotes as Handler, vi.mocked(createCreditNote) as never, 'POST', idify({"type": "customer", "creditDate": "2026-09-01", "subtotal": 10}) as Record<string, unknown>, idify({}) as Record<string, string>],
  ['supplier-credit-notes', hSupplierCreditNotes as Handler, vi.mocked(createCreditNote) as never, 'POST', idify({"supplierId": "ID", "creditDate": "2026-09-01", "lineItems": [{"description": "x", "quantity": 1, "unitPrice": 10}]}) as Record<string, unknown>, idify({}) as Record<string, string>],
];

beforeEach(() => { vi.clearAllMocks(); vi.mocked(sql).mockResolvedValue([{ id: ID, rate: 4.5, km_rate: 4.5 }] as never); });

describe.each(rows)('D11 %s', (_key, handler, service, method, body, query) => {
  it('a held row (typed lock timeout) -> 503 + Retry-After', async () => {
    service.mockRejectedValueOnce(heldTyped());
    const res = await call(handler, method, body, query);
    expect(res.statusCode, JSON.stringify(res.sent)).toBe(503);
    expect(res.headers['Retry-After']).toBe('2');
  });
  it('a deadlock victim (raw 40P01) -> 503 + Retry-After, without the driver text', async () => {
    service.mockRejectedValueOnce(deadlock());
    const res = await call(handler, method, body, query);
    expect(res.statusCode, JSON.stringify(res.sent)).toBe(503);
    expect(res.headers['Retry-After']).toBe('2');
    expect(JSON.stringify(res.sent)).not.toMatch(/deadlock detected/);
  });
  it('a number lock held past its bound (raw 55P03) -> 503 + Retry-After, without the driver text', async () => {
    service.mockRejectedValueOnce(numberLockTimeout());
    const res = await call(handler, method, body, query);
    expect(service).toHaveBeenCalled();
    expect(res.statusCode, JSON.stringify(res.sent)).toBe(503);
    expect(res.headers['Retry-After']).toBe('2');
    expect(JSON.stringify(res.sent)).not.toMatch(/lock timeout/);
  });
  it('an ordinary failure keeps its status (not a 503)', async () => {
    service.mockRejectedValueOnce(new Error('ordinary failure'));
    const res = await call(handler, method, body, query);
    expect(res.statusCode).not.toBe(503);
    expect(res.headers['Retry-After']).toBeUndefined();
  });
});

// The routes whose held row is raised by the document-number reservation or a plain statement, not a mocked service.
describe.each([
  ['supplier-invoices POST (the SIV sequence row)', hSupplierInvoices as Handler, 'POST',
    { supplierId: ID, invoiceDate: '2026-09-01', useSequence: true, items: [{ description: 'x', quantity: 1, unitPrice: 1 }] }, {},
    (e: Error) => vi.mocked(reserveSiv).mockRejectedValueOnce(e)],
  ['supplier-returns POST (the supplier_return sequence row)', hSupplierReturns as Handler, 'POST',
    { supplierId: ID, amount: 10, reason: 'x' }, {}, (e: Error) => {
      // The reservation runs inside the route's savepoint (withTransaction) since DOCNUM round 3.
      vi.mocked(withTransaction).mockImplementationOnce((fn) => fn(sql as never) as never);
      vi.mocked(reserveNextDocumentNumber).mockRejectedValueOnce(e);
    }],
  ['bank-transfers POST (the journal transaction)', hBankTransfers as Handler, 'POST',
    { fromAccountId: ID, toAccountId: '77777777-7777-4777-8777-777777777777', amount: 10 }, {},
    (e: Error) => {
      vi.mocked(sql).mockResolvedValue([{ id: ID, account_name: 'a' }, { id: '77777777-7777-4777-8777-777777777777', account_name: 'b' }] as never);
      vi.mocked(withTransaction).mockRejectedValueOnce(e);
    }],
  ['recurring-invoices PUT (a plain UPDATE)', hRecurringInvoices2 as Handler, 'PUT', { id: ID }, {},
    (e: Error) => vi.mocked(sql).mockRejectedValueOnce(e)],
  ['recurring-journals PUT (a plain UPDATE)', hRecurringJournals2 as Handler, 'PUT', { id: ID }, {},
    (e: Error) => vi.mocked(sql).mockRejectedValueOnce(e)],
] as const)('D11 %s', (_n, handler, method, body, query, arm) => {
  it('a held row (typed lock timeout) -> 503 + Retry-After', async () => {
    arm(heldTyped());
    const res = await call(handler, method, body, query);
    expect(res.statusCode, JSON.stringify(res.sent)).toBe(503);
    expect(res.headers['Retry-After']).toBe('2');
  });
  it('a deadlock victim (raw 40P01) -> 503 + Retry-After, without the driver text', async () => {
    arm(deadlock());
    const res = await call(handler, method, body, query);
    expect(res.statusCode, JSON.stringify(res.sent)).toBe(503);
    expect(JSON.stringify(res.sent)).not.toMatch(/deadlock detected/);
  });
  it('an ordinary failure keeps its status (not a 503)', async () => {
    arm(new Error('ordinary failure'));
    const res = await call(handler, method, body, query);
    expect(res.statusCode).not.toBe(503);
    expect(res.headers['Retry-After']).toBeUndefined();
  });
});
