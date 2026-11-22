/**
 * `settle_by_contra`: what the tool hands the payment services, pinned in full.
 *
 * The posting lives in `contraSettlementPosting`; these tests prove the TOOL still
 * calls it so that the same payloads reach the same services, with the token
 * owner as creator AND approver, and that a refusal the service raises is
 * answered as a toolError, not a thrown exception.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/core/approvePermission', async (orig) => ({ ...(await orig<object>()), mayApprove: vi.fn(async () => true) }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/core/contraSettlementService', () => ({
  assertContraAccountUsable: vi.fn(),
  loadContraDocument: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/customerPaymentService', () => ({
  createCustomerPayment: vi.fn(),
  confirmCustomerPayment: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ap/supplierPaymentService', () => ({
  createSupplierPayment: vi.fn(),
  approveSupplierPayment: vi.fn(),
  processSupplierPayment: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({ getSystemAccount: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/approvalUnattended', () => ({
  agentNewSupplierPaymentRefusal: vi.fn().mockResolvedValue(null),
}));

import { mayApprove } from '@/modules/accounting/services/core/approvePermission';
import { assertContraAccountUsable, loadContraDocument } from '@/modules/accounting/services/core/contraSettlementService';
import { createCustomerPayment, confirmCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentService';
import { createSupplierPayment, approveSupplierPayment, processSupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentService';
import { getSystemAccount } from '@/modules/accounting/services/gl/systemAccountResolver';
import { agentNewSupplierPaymentRefusal } from '@/modules/accounting/services/gl/approvalUnattended';
import { settleByContraTool } from '@/lib/mcp/tools/writeSettleByContra';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const USER = '99999999-9999-4999-8999-999999999999';
const PAYMENT = '33333333-3333-4333-8333-333333333333';
const INVOICE = '55555555-5555-4555-8555-555555555555';
const COUNTERPARTY = '88888888-8888-4888-8888-888888888888';
const CONTRA = '77777777-7777-4777-8777-777777777777';
const REASON = 'Netted against the director loan';
const BASE = {
  idempotency_key: 'k1', subledger: 'ar', document_id: INVOICE, contra_account_id: CONTRA,
  amount: 400, reason: REASON, settlement_date: '2026-11-20',
};

const ctx = (): McpToolContext => ({
  userId: USER, companyId: COMPANY, scopes: ['write:invoices', 'write:post'], tokenJti: 'jti', oauthAppId: null,
});
const text = (r: McpToolResult) => r.content[0]!.text;
const PAYLOAD = {
  paymentDate: '2026-11-20', totalAmount: 400, paymentMethod: 'contra', bankAccountId: CONTRA,
  description: `Contra settlement — ${REASON}`, allocations: [{ invoiceId: INVOICE, amount: 400 }],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(mayApprove).mockResolvedValue(true);
  vi.mocked(agentNewSupplierPaymentRefusal).mockResolvedValue(null);
  vi.mocked(assertContraAccountUsable).mockResolvedValue({
    accountId: CONTRA, accountCode: '2400', accountName: 'Loan', accountType: 'liability',
  });
  vi.mocked(loadContraDocument).mockResolvedValue({
    documentId: INVOICE, documentNumber: 'INV0001', counterpartyId: COUNTERPARTY,
    totalAmount: 1000, amountPaid: 0, outstanding: 1000, status: 'approved',
  });
  vi.mocked(getSystemAccount).mockResolvedValue({ id: 'ctl', accountCode: '1120', accountName: 'Control' } as never);
  vi.mocked(createCustomerPayment).mockResolvedValue({ id: PAYMENT } as never);
  vi.mocked(confirmCustomerPayment).mockResolvedValue({ id: PAYMENT, paymentNumber: 'RCP1', glJournalEntryId: 'je-1' } as never);
  vi.mocked(createSupplierPayment).mockResolvedValue({ id: PAYMENT } as never);
  vi.mocked(approveSupplierPayment).mockResolvedValue({ id: PAYMENT } as never);
  vi.mocked(processSupplierPayment).mockResolvedValue({ id: PAYMENT, paymentNumber: 'PAY1', glJournalEntryId: 'je-2' } as never);
});

describe('settle_by_contra payloads', () => {
  it('AR: create and confirm receive the token owner and the full payload', async () => {
    const r = await settleByContraTool.handler(BASE, ctx());
    expect(r.isError).toBeFalsy();
    expect(createCustomerPayment).toHaveBeenCalledWith(COMPANY, { ...PAYLOAD, clientId: COUNTERPARTY }, USER);
    expect(confirmCustomerPayment).toHaveBeenCalledWith(COMPANY, PAYMENT, USER, { postingAgent: 'mcp:settle_by_contra:v1' });
    expect(mayApprove).toHaveBeenCalledWith(COMPANY, USER, 'customers');
    const out = JSON.parse(text(r));
    expect(out).toMatchObject({
      payment_id: PAYMENT, payment_number: 'RCP1', posted_journal_entry_id: 'je-1', payment_method: 'contra',
      journal: 'DR 2400 Loan / CR 1120 Control', outstanding_before: 1000, outstanding_after: 600,
    });
  });

  it('AP: create, approve (as the token owner) and process receive the full payloads', async () => {
    const r = await settleByContraTool.handler({ ...BASE, subledger: 'ap' }, ctx());
    expect(r.isError).toBeFalsy();
    expect(createSupplierPayment).toHaveBeenCalledWith(COMPANY, { ...PAYLOAD, supplierId: COUNTERPARTY }, USER);
    expect(approveSupplierPayment).toHaveBeenCalledWith(COMPANY, PAYMENT, USER);
    expect(processSupplierPayment).toHaveBeenCalledWith(COMPANY, PAYMENT, USER, { postingAgent: 'mcp:settle_by_contra:v1' });
    expect(mayApprove).toHaveBeenCalledWith(COMPANY, USER, 'suppliers');
    expect(JSON.parse(text(r))).toMatchObject({ payment_number: 'PAY1', posted_journal_entry_id: 'je-2' });
  });

  it('a refusal the service raises after the tool\'s own reads passed (a lost race) is a toolError, not a throw', async () => {
    vi.mocked(assertContraAccountUsable)
      .mockResolvedValueOnce({ accountId: CONTRA, accountCode: '2400', accountName: 'Loan', accountType: 'liability' })
      .mockRejectedValueOnce(new Error('2400 Loan is deactivated.'));
    const r = await settleByContraTool.handler(BASE, ctx());
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/deactivated/);
    expect(createCustomerPayment).not.toHaveBeenCalled();
  });

  it('an approver refusal raised by the service is answered as a toolError', async () => {
    vi.mocked(mayApprove).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const r = await settleByContraTool.handler({ ...BASE, subledger: 'ap' }, ctx());
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/permission to approve/);
    expect(createSupplierPayment).not.toHaveBeenCalled();
  });

  it('R-035: an enforced rule refuses a payable with the gate\'s text and no write', async () => {
    vi.mocked(agentNewSupplierPaymentRefusal).mockResolvedValue('Supplier payments are enforced: needs approval');
    const r = await settleByContraTool.handler({ ...BASE, subledger: 'ap' }, ctx());
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Supplier payments are enforced/);
    expect(createSupplierPayment).not.toHaveBeenCalled();
  });
});
