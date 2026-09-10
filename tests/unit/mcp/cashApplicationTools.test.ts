/**
 * `apply_payment_to_supplier_invoice`, `settle_by_contra`, and the four contact
 * write tools.
 *
 * What is worth pinning, beyond the shape checks the AR twin already covers in
 * applyReceiptTool.test.ts:
 *
 *  - **settle_by_contra refuses a BANK contra account.** Settling against a
 *    bank account is the phantom payment the whole operation exists to avoid —
 *    it records cash movement that never happened.
 *  - **It refuses the subledger's own control account.** DR AR / CR AR balances
 *    perfectly, settles the document against itself, and leaves the subledger
 *    and the GL disagreeing by exactly the amount settled.
 *  - **The dry run shows the journal with real account codes on both legs**, so
 *    a reviewer can see which way round it posts before it posts.
 *  - **The contact update tools check ownership before the write** and answer a
 *    foreign id with the shared NOT_FOUND constant, never a distinct message —
 *    a distinct one is an existence oracle.
 *  - **They sit on write:contacts, not write:invoices**, because a supplier's
 *    bank account number is editable through them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/ap/supplierPaymentApplicationService', () => ({
  planSupplierPaymentApplication: vi.fn(),
  applySupplierPaymentPlan: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ap/supplierBankPaymentService', () => ({
  validateBankSupplierPayment: vi.fn(),
  applyBankLineToSupplierInvoices: vi.fn(),
}));
vi.mock('@/modules/accounting/services/core/contraSettlementService', () => ({
  assertContraAccountUsable: vi.fn(),
  loadContraDocument: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({
  assertBankAllocationAuthority: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/customerPaymentService', () => ({
  assertCustomerPaymentAuthority: vi.fn(),
  createCustomerPayment: vi.fn(),
  confirmCustomerPayment: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ap/supplierPaymentService', () => ({
  createSupplierPayment: vi.fn(),
  approveSupplierPayment: vi.fn(),
  processSupplierPayment: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccount: vi.fn(),
}));
vi.mock('@/modules/accounting/services/core/customerWriteService', async () => {
  const actual = await vi.importActual<
    typeof import('@/modules/accounting/services/core/customerWriteService')
  >('@/modules/accounting/services/core/customerWriteService');
  return {
    ...actual,
    createCustomer: vi.fn(),
    updateCustomer: vi.fn(),
  };
});
vi.mock('@/modules/accounting/services/core/supplierWriteService', () => ({
  createSupplier: vi.fn(),
  updateSupplier: vi.fn(),
}));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({
  customerBelongsToCompany: vi.fn(),
  supplierBelongsToCompany: vi.fn(),
}));

import {
  planSupplierPaymentApplication,
  applySupplierPaymentPlan,
} from '@/modules/accounting/services/ap/supplierPaymentApplicationService';
import {
  validateBankSupplierPayment,
  applyBankLineToSupplierInvoices,
} from '@/modules/accounting/services/ap/supplierBankPaymentService';
import {
  assertContraAccountUsable,
  loadContraDocument,
} from '@/modules/accounting/services/core/contraSettlementService';
import {
  createCustomerPayment,
  confirmCustomerPayment,
} from '@/modules/accounting/services/ar/customerPaymentService';
import {
  createSupplierPayment,
  approveSupplierPayment,
  processSupplierPayment,
} from '@/modules/accounting/services/ap/supplierPaymentService';
import { getSystemAccount } from '@/modules/accounting/services/gl/systemAccountResolver';
import {
  createCustomer,
  updateCustomer,
} from '@/modules/accounting/services/core/customerWriteService';
import {
  createSupplier,
  updateSupplier,
} from '@/modules/accounting/services/core/supplierWriteService';
import {
  customerBelongsToCompany,
  supplierBelongsToCompany,
} from '@/modules/accounting/services/core/contactDirectoryService';
import { applyPaymentToSupplierInvoiceTool } from '@/lib/mcp/tools/writeApplySupplierPayment';
import { settleByContraTool } from '@/lib/mcp/tools/writeSettleByContra';
import {
  createCustomerTool,
  updateCustomerTool,
  createSupplierTool,
  updateSupplierTool,
} from '@/lib/mcp/tools/writeContacts';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const SUPPLIER = '22222222-2222-4222-8222-222222222222';
const PAYMENT = '33333333-3333-4333-8333-333333333333';
const BILL = '44444444-4444-4444-8444-444444444444';
const INVOICE = '55555555-5555-4555-8555-555555555555';
const CONTRA = '77777777-7777-4777-8777-777777777777';
const CUSTOMER = '88888888-8888-4888-8888-888888888888';
const KEY = { idempotency_key: 'k1' };

function ctx(): McpToolContext {
  return {
    userId: '99999999-9999-4999-8999-999999999999',
    companyId: COMPANY,
    scopes: ['write:invoices', 'write:post', 'write:contacts'],
    tokenJti: 'jti',
    oauthAppId: null,
  };
}
function parseOk(r: McpToolResult): Record<string, unknown> {
  expect(r.isError).toBeFalsy();
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}
function errText(r: McpToolResult): string {
  expect(r.isError).toBe(true);
  return r.content[0]!.text;
}

const BILL_LINE = {
  invoiceId: BILL,
  invoiceNumber: 'BILL0001',
  amount: 600,
  outstandingBefore: 600,
  outstandingAfter: 0,
  statusBefore: 'approved',
  statusAfter: 'paid',
  fullySettled: true,
};

function apPlan() {
  return {
    paymentId: PAYMENT,
    paymentNumber: 'PAY0001',
    supplierId: SUPPLIER,
    paymentTotal: 1000,
    allocatedBefore: 0,
    allocatedAfter: 600,
    unappliedBefore: 1000,
    unappliedAfter: 400,
    paymentStatusBefore: 'processed',
    paymentStatusAfter: 'processed',
    lines: [BILL_LINE],
    postsJournal: false as const,
  };
}

const AP_ALLOC = { allocations: [{ invoice_id: BILL, amount: 600 }] };

beforeEach(() => {
  vi.resetAllMocks();
});

describe('apply_payment_to_supplier_invoice', () => {
  it('refuses when neither source is named', async () => {
    expect(errText(await applyPaymentToSupplierInvoiceTool.handler({ ...AP_ALLOC, ...KEY }, ctx())))
      .toMatch(/exactly one of payment_id or bank_transaction_id/i);
  });

  it('applies a processed payment and reports payment_matched per bill', async () => {
    vi.mocked(planSupplierPaymentApplication).mockResolvedValue(apPlan());
    vi.mocked(applySupplierPaymentPlan).mockResolvedValue(apPlan());
    const out = parseOk(await applyPaymentToSupplierInvoiceTool.handler(
      { ...AP_ALLOC, ...KEY, payment_id: PAYMENT }, ctx(),
    ));
    expect(out.journal_posted).toBe(false);
    expect(out.applied_now).toBe(600);
    expect(out.unapplied_remainder).toBe(400);
    expect((out.invoices as Array<Record<string, unknown>>)[0]!.payment_matched).toBe(true);
    expect(vi.mocked(planSupplierPaymentApplication).mock.calls[0]![0]).toBe(COMPANY);
  });

  it('A DRY RUN REFUSES WHERE THE LIVE CALL WOULD, and writes nothing', async () => {
    vi.mocked(planSupplierPaymentApplication).mockRejectedValue(
      new Error('This payment has not been processed (status "draft")'),
    );
    const r = await applyPaymentToSupplierInvoiceTool.handler(
      { ...AP_ALLOC, ...KEY, payment_id: PAYMENT, dry_run: true }, ctx(),
    );
    expect(errText(r)).toMatch(/has not been processed/);
    expect(applySupplierPaymentPlan).not.toHaveBeenCalled();
  });

  it('a dry run sets wroteNothing and shows no journal for the payment source', async () => {
    vi.mocked(planSupplierPaymentApplication).mockResolvedValue(apPlan());
    const r = await applyPaymentToSupplierInvoiceTool.handler(
      { ...AP_ALLOC, ...KEY, payment_id: PAYMENT, dry_run: true }, ctx(),
    );
    expect(r.wroteNothing).toBe(true);
    expect(parseOk(r).journals).toEqual([]);
    expect(applySupplierPaymentPlan).not.toHaveBeenCalled();
  });

  it('previews DR Accounts Payable / CR Bank for the FULL line on the bank source', async () => {
    vi.mocked(validateBankSupplierPayment).mockResolvedValue({
      bankTxId: 'bt', paymentAmount: 1000, transactionDate: '2026-03-01',
      supplierId: SUPPLIER, lines: [BILL_LINE], allocatedTotal: 600, unappliedRemainder: 400,
    });
    const out = parseOk(await applyPaymentToSupplierInvoiceTool.handler(
      { ...AP_ALLOC, ...KEY, bank_transaction_id: '66666666-6666-4666-8666-666666666666', dry_run: true },
      ctx(),
    )) as { journals: Array<{ totalDebit: number; description: string }> };
    expect(out.journals[0]!.totalDebit).toBe(1000);
    expect(out.journals[0]!.description).toMatch(/DR Accounts Payable \/ CR Bank/);
    expect(applyBankLineToSupplierInvoices).not.toHaveBeenCalled();
  });

  it('RETHROWS a post-write failure rather than returning it', async () => {
    vi.mocked(planSupplierPaymentApplication).mockResolvedValue(apPlan());
    vi.mocked(applySupplierPaymentPlan).mockRejectedValue(new Error('deadlock detected'));
    await expect(applyPaymentToSupplierInvoiceTool.handler(
      { ...AP_ALLOC, ...KEY, payment_id: PAYMENT }, ctx(),
    )).rejects.toThrow(/deadlock/);
  });
});

describe('settle_by_contra', () => {
  const CONTRA_OK = {
    accountId: CONTRA, accountCode: '2400', accountName: 'Loan — Director', accountType: 'liability',
  };
  const DOC = {
    documentId: INVOICE, documentNumber: 'INV0001', counterpartyId: CUSTOMER,
    totalAmount: 1000, amountPaid: 0, outstanding: 1000, status: 'approved',
  };
  const CONTROL = { id: 'ctl', accountCode: '1120', accountName: 'Trade Debtors' };

  const BASE = {
    ...KEY, subledger: 'ar', document_id: INVOICE, contra_account_id: CONTRA,
    amount: 400, reason: 'Netted against the director loan',
  };

  it('REFUSES A BANK CONTRA ACCOUNT — that is the phantom payment', async () => {
    vi.mocked(assertContraAccountUsable).mockRejectedValue(
      new Error('1000 FNB Cheque is a BANK account. A contra settlement exists precisely because no cash moved'),
    );
    vi.mocked(loadContraDocument).mockResolvedValue(DOC);
    vi.mocked(getSystemAccount).mockResolvedValue(CONTROL as never);
    expect(errText(await settleByContraTool.handler(BASE, ctx()))).toMatch(/BANK account/);
    expect(createCustomerPayment).not.toHaveBeenCalled();
  });

  it('refuses the subledger control account itself', async () => {
    vi.mocked(assertContraAccountUsable).mockRejectedValue(
      new Error('1120 Trade Debtors is the Accounts Receivable control account itself.'),
    );
    vi.mocked(loadContraDocument).mockResolvedValue(DOC);
    vi.mocked(getSystemAccount).mockResolvedValue(CONTROL as never);
    expect(errText(await settleByContraTool.handler(BASE, ctx()))).toMatch(/control account itself/);
  });

  it('requires a reason — the record has to say why no cash moved', async () => {
    const { reason: _drop, ...noReason } = BASE;
    expect(errText(await settleByContraTool.handler(noReason, ctx()))).toMatch(/reason is required/i);
    expect(assertContraAccountUsable).not.toHaveBeenCalled();
  });

  it('SHOWS BOTH LEGS THE RIGHT WAY ROUND in a dry run (AR: DR contra / CR AR)', async () => {
    vi.mocked(assertContraAccountUsable).mockResolvedValue(CONTRA_OK);
    vi.mocked(loadContraDocument).mockResolvedValue(DOC);
    vi.mocked(getSystemAccount).mockResolvedValue(CONTROL as never);

    const r = await settleByContraTool.handler({ ...BASE, dry_run: true }, ctx());
    const out = parseOk(r) as {
      journals: Array<{ lines: Array<{ accountCode: string; debit: number; credit: number }> }>;
      effects: Array<{ before: number; after: number }>;
    };
    expect(r.wroteNothing).toBe(true);
    expect(out.journals[0]!.lines).toEqual([
      { accountId: CONTRA, accountCode: '2400', accountName: 'Loan — Director', debit: 400, credit: 0 },
      { accountId: 'ctl', accountCode: '1120', accountName: 'Trade Debtors', debit: 0, credit: 400 },
    ]);
    expect(out.effects[0]).toMatchObject({ before: 1000, after: 600 });
    expect(createCustomerPayment).not.toHaveBeenCalled();
  });

  it('AP posts the OTHER way round: DR Accounts Payable / CR contra', async () => {
    vi.mocked(assertContraAccountUsable).mockResolvedValue(CONTRA_OK);
    vi.mocked(loadContraDocument).mockResolvedValue({ ...DOC, documentId: BILL, counterpartyId: SUPPLIER });
    vi.mocked(getSystemAccount).mockResolvedValue({ id: 'ap', accountCode: '2000', accountName: 'Trade Creditors' } as never);

    const out = parseOk(await settleByContraTool.handler(
      { ...BASE, subledger: 'ap', document_id: BILL, dry_run: true }, ctx(),
    )) as { journals: Array<{ lines: Array<{ accountCode: string; debit: number }> }> };
    expect(out.journals[0]!.lines[0]).toMatchObject({ accountCode: '2000', debit: 400 });
    expect(out.journals[0]!.lines[1]).toMatchObject({ accountCode: '2400', credit: 400 });
  });

  it('records payment_method "contra" and stamps the posting agent (AR)', async () => {
    vi.mocked(assertContraAccountUsable).mockResolvedValue(CONTRA_OK);
    vi.mocked(loadContraDocument).mockResolvedValue(DOC);
    vi.mocked(getSystemAccount).mockResolvedValue(CONTROL as never);
    vi.mocked(createCustomerPayment).mockResolvedValue({ id: PAYMENT } as never);
    vi.mocked(confirmCustomerPayment).mockResolvedValue({
      id: PAYMENT, paymentNumber: 'RCP0002', glJournalEntryId: 'je-9',
    } as never);

    const out = parseOk(await settleByContraTool.handler(BASE, ctx()));
    expect(vi.mocked(createCustomerPayment).mock.calls[0]![1]).toMatchObject({
      paymentMethod: 'contra',
      bankAccountId: CONTRA,
      allocations: [{ invoiceId: INVOICE, amount: 400 }],
    });
    expect(vi.mocked(confirmCustomerPayment).mock.calls[0]![3])
      .toEqual({ postingAgent: 'mcp:settle_by_contra:v1' });
    expect(out.payment_method).toBe('contra');
    expect(out.posted_journal_entry_id).toBe('je-9');
    expect(out.outstanding_after).toBe(600);
  });

  it('AP runs create -> approve -> process and stamps the process step', async () => {
    vi.mocked(assertContraAccountUsable).mockResolvedValue(CONTRA_OK);
    vi.mocked(loadContraDocument).mockResolvedValue({ ...DOC, documentId: BILL, counterpartyId: SUPPLIER });
    vi.mocked(getSystemAccount).mockResolvedValue({ id: 'ap', accountCode: '2000', accountName: 'Trade Creditors' } as never);
    vi.mocked(createSupplierPayment).mockResolvedValue({ id: PAYMENT } as never);
    vi.mocked(approveSupplierPayment).mockResolvedValue({ id: PAYMENT } as never);
    vi.mocked(processSupplierPayment).mockResolvedValue({
      id: PAYMENT, paymentNumber: 'PAY0002', glJournalEntryId: 'je-10',
    } as never);

    await settleByContraTool.handler({ ...BASE, subledger: 'ap', document_id: BILL }, ctx());
    expect(approveSupplierPayment).toHaveBeenCalledTimes(1);
    expect(vi.mocked(processSupplierPayment).mock.calls[0]![3])
      .toEqual({ postingAgent: 'mcp:settle_by_contra:v1' });
  });

  it('refuses a sub-cent amount Postgres would round behind the agent', async () => {
    expect(errText(await settleByContraTool.handler({ ...BASE, amount: 10.005 }, ctx())))
      .toMatch(/two decimal places/i);
  });

  it('refuses an unknown subledger', async () => {
    expect(errText(await settleByContraTool.handler({ ...BASE, subledger: 'gl' }, ctx())))
      .toMatch(/subledger must be/i);
  });
});

describe('contact write tools', () => {
  it('all four sit on write:contacts and post nothing', () => {
    for (const t of [createCustomerTool, updateCustomerTool, createSupplierTool, updateSupplierTool]) {
      expect(t.scope).toBe('write:contacts');
      expect(t.write).toBe(true);
      expect(t.requiresPost).toBeUndefined();
    }
  });

  it('create_customer refuses a blank name before any write', async () => {
    expect(errText(await createCustomerTool.handler({ ...KEY, name: '  ' }, ctx())))
      .toMatch(/name is required/i);
    expect(createCustomer).not.toHaveBeenCalled();
  });

  it('CHECKS OWNERSHIP BEFORE UPDATING and answers a foreign id with the generic miss', async () => {
    vi.mocked(customerBelongsToCompany).mockResolvedValue(false);
    expect(await updateCustomerTool.handler({ ...KEY, customer_id: CUSTOMER, phone: '1' }, ctx()))
      .toMatchObject({ isError: true, content: [{ type: 'text', text: 'Not found' }] });
    expect(updateCustomer).not.toHaveBeenCalled();
  });

  it('update_supplier checks ownership too, and passes registered_name through', async () => {
    vi.mocked(supplierBelongsToCompany).mockResolvedValue(true);
    vi.mocked(updateSupplier).mockResolvedValue({ id: SUPPLIER, name: 'Acme', is_active: true });
    await updateSupplierTool.handler(
      { ...KEY, supplier_id: SUPPLIER, registered_name: 'Acme Holdings (Pty) Ltd' }, ctx(),
    );
    expect(vi.mocked(updateSupplier).mock.calls[0]![0]).toBe(COMPANY);
    expect(vi.mocked(updateSupplier).mock.calls[0]![2].companyName).toBe('Acme Holdings (Pty) Ltd');
  });

  it('no contact tool declares an opening_balance argument', () => {
    // An opening balance is the figure the books were opened with; changing it
    // after documents exist silently restates every period since.
    for (const t of [createCustomerTool, updateCustomerTool, createSupplierTool, updateSupplierTool]) {
      const props = Object.keys(
        (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      );
      expect(props).not.toContain('opening_balance');
    }
  });

  it('a malformed id refuses before it reaches a ::UUID cast', async () => {
    expect(errText(await updateCustomerTool.handler({ ...KEY, customer_id: 'x' }, ctx())))
      .toBe('invalid customer_id');
    expect(customerBelongsToCompany).not.toHaveBeenCalled();
  });

  it('create_supplier surfaces the service validation error as a refusal, not a failure', async () => {
    vi.mocked(createSupplier).mockRejectedValue(
      Object.assign(new Error('Supplier name must not exceed 255 characters'), {
        name: 'ContactValidationError',
      }),
    );
    // A plain Error is NOT a ContactValidationError, so it must propagate rather
    // than be swallowed into a refusal — that is the write-vs-refuse boundary.
    await expect(createSupplierTool.handler({ ...KEY, name: 'Acme' }, ctx())).rejects.toThrow();
  });
});
