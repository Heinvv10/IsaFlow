/**
 * contraSettlementPosting — every refusal, and what is NOT a refusal. The
 * composition of the writes is in contraSettlementPosting.test.ts.
 *
 * Each refusal (bound transaction, input, approver permission, the guards, the
 * R-035 gate) is thrown from inside the service before the first write, whatever
 * the caller did earlier; a database failure is thrown unchanged and untagged;
 * the writes run in one savepoint.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bindRequestTx } from '../../../helpers/boundRequestTx';
import { als } from '@/lib/als';

const spLog: string[] = [];
vi.mock('@/modules/accounting/services/intercompany/loanAccountPaymentGuard', () => ({ loanAccountPaymentRefusal: vi.fn(async () => null) })); // P4-E guard: intercompany suites
vi.mock('@/lib/neon', () => ({
  // Records what a real savepoint does: SAVEPOINT, run, then RELEASE on success or ROLLBACK TO on a throw.
  withSavepoint: vi.fn(async (name: string, fn: () => Promise<unknown>) => {
    spLog.push(`SAVEPOINT ${name}`);
    try { const r = await fn(); spLog.push(`RELEASE ${name}`); return r; }
    catch (e) { spLog.push(`ROLLBACK TO ${name}`); throw e; }
  }),
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/core/contraSettlementService', () => ({
  assertContraAccountUsable: vi.fn(),
  loadContraDocument: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({ getSystemAccount: vi.fn() }));
vi.mock('@/modules/accounting/services/core/approvePermission', async (orig) => ({
  ...(await orig<object>()), mayApprove: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/approvalUnattended', () => ({ agentNewSupplierPaymentRefusal: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/customerPaymentService', () => ({
  createCustomerPayment: vi.fn(),
  confirmCustomerPayment: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ap/supplierPaymentService', () => ({
  createSupplierPayment: vi.fn(),
  approveSupplierPayment: vi.fn(),
  processSupplierPayment: vi.fn(),
}));

import {
  assertContraAccountUsable,
  loadContraDocument,
} from '@/modules/accounting/services/core/contraSettlementService';
import { getSystemAccount } from '@/modules/accounting/services/gl/systemAccountResolver';
import { createCustomerPayment, confirmCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentService';
import {
  createSupplierPayment,
  approveSupplierPayment,
  processSupplierPayment,
} from '@/modules/accounting/services/ap/supplierPaymentService';
import { mayApprove, ApprovePermissionError } from '@/modules/accounting/services/core/approvePermission';
import { MissingSystemAccountError } from '@/modules/accounting/services/gl/systemAccountKeys';
import { agentNewSupplierPaymentRefusal } from '@/modules/accounting/services/gl/approvalUnattended';
import {
  settleDocumentByContra,
  ContraSettlementRefusal,
  isContraPreWriteRefusal,
  type ContraSettlementActor,
} from '@/modules/accounting/services/core/contraSettlementPosting';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const COUNTERPARTY = '22222222-2222-4222-8222-222222222222';
const PAYMENT = '33333333-3333-4333-8333-333333333333';
const DOC = '44444444-4444-4444-8444-444444444444';
const CONTRA = '77777777-7777-4777-8777-777777777777';

const CONTRA_OK = { accountId: CONTRA, accountCode: '2400', accountName: 'Loan', accountType: 'liability' };
const DOCUMENT = {
  documentId: DOC, documentNumber: 'INV0001', counterpartyId: COUNTERPARTY,
  totalAmount: 1000, amountPaid: 0, outstanding: 1000, status: 'approved',
};
const ACTOR: ContraSettlementActor = { userId: 'user-1', approverUserId: 'user-1', postingAgent: 'system:test:v1' };

const run = (subledger: 'ar' | 'ap', over: Partial<Parameters<typeof settleDocumentByContra>[0]> = {}) =>
  settleDocumentByContra({
    companyId: COMPANY, subledger, documentId: DOC, contraAccountId: CONTRA, amount: 400,
    date: '2026-11-20', reason: 'Netted', actor: ACTOR, ...over,
  });

const noWrites = () => {
  for (const f of [createCustomerPayment, confirmCustomerPayment, createSupplierPayment, approveSupplierPayment, processSupplierPayment]) {
    expect(f).not.toHaveBeenCalled();
  }
};

/** What the contra guards throw: an Error carrying their refusal code. */
const guardRefusal = (m: string) => Object.assign(new Error(m), { code: 'CONTRA_SETTLEMENT_REFUSED' });

beforeEach(() => {
  vi.resetAllMocks();
  spLog.length = 0;
  bindRequestTx(COMPANY);
  vi.mocked(mayApprove).mockResolvedValue(true);
  vi.mocked(agentNewSupplierPaymentRefusal).mockResolvedValue(null);
  vi.mocked(assertContraAccountUsable).mockResolvedValue(CONTRA_OK);
  vi.mocked(loadContraDocument).mockResolvedValue(DOCUMENT);
  vi.mocked(getSystemAccount).mockResolvedValue({ id: 'ctl', accountCode: '1120', accountName: 'Control' } as never);
  vi.mocked(createCustomerPayment).mockResolvedValue({ id: PAYMENT } as never);
  vi.mocked(confirmCustomerPayment).mockResolvedValue({ id: PAYMENT, paymentNumber: 'RCP1', glJournalEntryId: 'je-1' } as never);
  vi.mocked(createSupplierPayment).mockResolvedValue({ id: PAYMENT } as never);
  vi.mocked(approveSupplierPayment).mockResolvedValue({ id: PAYMENT } as never);
  vi.mocked(processSupplierPayment).mockResolvedValue({ id: PAYMENT, paymentNumber: 'PAY1', glJournalEntryId: 'je-2' } as never);
});

describe('every refusal comes before the first write, from inside the service', () => {
  it('a hand-forged input naming a BANK contra account cannot post: the guard re-runs and throws', async () => {
    vi.mocked(assertContraAccountUsable).mockRejectedValue(guardRefusal('1000 FNB is a BANK account.'));
    for (const sub of ['ar', 'ap'] as const) {
      const err = await run(sub, { contraAccountId: 'bank-account-id' }).catch((e) => e);
      expect(err).toBeInstanceOf(ContraSettlementRefusal);
      expect(err.message).toMatch(/BANK account/);
      expect(err.underlying).toBeInstanceOf(Error);
    }
    expect(assertContraAccountUsable).toHaveBeenCalledWith(COMPANY, 'ar', 'bank-account-id');
    noWrites();
  });

  it('an amount above the outstanding balance on the document, read now, cannot post', async () => {
    vi.mocked(loadContraDocument).mockRejectedValue(guardRefusal('R400.00 exceeds the R100.00 outstanding'));
    await expect(run('ap')).rejects.toThrow(/exceeds/);
    expect(loadContraDocument).toHaveBeenCalledWith(COMPANY, 'ap', DOC, 400);
    noWrites();
  });

  it.each([0, -5, 10.005, Number.NaN])('amount %s is refused before anything is read', async (amount) => {
    await expect(run('ar', { amount })).rejects.toBeInstanceOf(ContraSettlementRefusal);
    expect(assertContraAccountUsable).not.toHaveBeenCalled();
    noWrites();
  });

  it('an approver without Customers & AR Approve is refused on a receivable, before any read or write', async () => {
    vi.mocked(mayApprove).mockResolvedValue(false);
    await expect(run('ar')).rejects.toBeInstanceOf(ApprovePermissionError);
    expect(mayApprove).toHaveBeenCalledWith(COMPANY, 'user-1', 'customers');
    expect(assertContraAccountUsable).not.toHaveBeenCalled();
    noWrites();
  });

  it('an approver without Suppliers & AP Approve is refused on a payable, before any read or write', async () => {
    vi.mocked(mayApprove).mockResolvedValue(false);
    await expect(run('ap')).rejects.toBeInstanceOf(ApprovePermissionError);
    expect(mayApprove).toHaveBeenCalledWith(COMPANY, 'user-1', 'suppliers');
    expect(assertContraAccountUsable).not.toHaveBeenCalled();
    noWrites();
  });

  it('R-035: an enforced rule on a new supplier payment refuses before createSupplierPayment', async () => {
    vi.mocked(agentNewSupplierPaymentRefusal).mockResolvedValue('Supplier payments are enforced: needs approval');
    const err = await run('ap').catch((e) => e);
    expect(err).toBeInstanceOf(ContraSettlementRefusal);
    expect(err.message).toMatch(/enforced/);
    expect(agentNewSupplierPaymentRefusal).toHaveBeenCalledWith(COMPANY, 400);
    noWrites();
  });

});

describe('needs a bound transaction of this company (untagged programming errors)', () => {
  const unread = () => { expect(mayApprove).not.toHaveBeenCalled(); expect(assertContraAccountUsable).not.toHaveBeenCalled(); noWrites(); };

  it('with no request or receiver transaction bound it throws before any read or write', async () => {
    const err = await als.exit(() => run('ap')).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/needs a request or receiver transaction/);
    expect(err).not.toBeInstanceOf(ContraSettlementRefusal);
    expect(isContraPreWriteRefusal(err)).toBe(false);
    unread();
  });

  it('a transaction bound for another company throws before any read or write', async () => {
    bindRequestTx('99999999-9999-4999-8999-999999999999');
    const err = await run('ar').catch((e) => e);
    expect(err.message).toMatch(/belongs to another company/);
    expect(isContraPreWriteRefusal(err)).toBe(false);
    unread();
  });

  it('a platform-admin store carrying no company is accepted', async () => {
    bindRequestTx(COMPANY, { companyId: undefined });
    await expect(run('ar')).resolves.toBeDefined();
  });
});

describe('input and actor refusals, before anything is read', () => {
  const untouched = () => { expect(mayApprove).not.toHaveBeenCalled(); expect(assertContraAccountUsable).not.toHaveBeenCalled(); noWrites(); };

  it.each(['gl', '', 'AR', undefined])('subledger %s is refused', async (sub) => {
    const err = await run(sub as never).catch((e) => e);
    expect(err).toBeInstanceOf(ContraSettlementRefusal);
    expect(err.message).toMatch(/subledger/);
    untouched();
  });

  it.each([
    '', 'human:hein', 'user:hein', 'mcp:', 'agent:x:v1', 'MCP:x', 'ai:x:v1', 'rule:r1', 'mcp:Upper',
    'mcp:ok\nhuman:hein', 'mcp:ok\n', 'mcp:a\0b', 'system:x y', `mcp:${'a'.repeat(81)}`,
  ])('postingAgent %j is refused', async (postingAgent) => {
    await expect(run('ar', { actor: { ...ACTOR, postingAgent } })).rejects.toBeInstanceOf(ContraSettlementRefusal);
    untouched();
  });

  it('a non-string postingAgent is refused', async () => {
    await expect(run('ar', { actor: { ...ACTOR, postingAgent: undefined as never } })).rejects.toBeInstanceOf(ContraSettlementRefusal);
    untouched();
  });

  it.each(['mcp:settle_by_contra:v1', 'system:ic-worker:v1', `mcp:${'a'.repeat(80)}`])('postingAgent "%s" is accepted', async (postingAgent) => {
    await expect(run('ar', { actor: { ...ACTOR, postingAgent } })).resolves.toBeDefined();
  });

  it.each(['', '   ', '\n\t', undefined, null, 5])('reason %j is refused', async (reason) => {
    const err = await run('ar', { reason: reason as never }).catch((e) => e);
    expect(err).toBeInstanceOf(ContraSettlementRefusal);
    expect(err.message).toMatch(/reason is required/);
    untouched();
  });

  it('until a human decision record exists, the creator must be the approver', async () => {
    for (const sub of ['ar', 'ap'] as const) {
      const err = await run(sub, { actor: { ...ACTOR, approverUserId: 'someone-else' } }).catch((e) => e);
      expect(err).toBeInstanceOf(ContraSettlementRefusal);
      expect(err.message).toMatch(/creates a contra settlement must be the one who approves/);
    }
    untouched();
  });
});

describe('errors that are not refusals', () => {
  it.each(['40P01', '57014', 'ECONNRESET'])('a %s from a guard read is rethrown unchanged, not wrapped', async (code) => {
    const dbErr = Object.assign(new Error('deadlock detected'), { code });
    vi.mocked(loadContraDocument).mockRejectedValue(dbErr);
    const err = await run('ar').catch((e) => e);
    expect(err).toBe(dbErr);
    expect(err).not.toBeInstanceOf(ContraSettlementRefusal);
    expect(isContraPreWriteRefusal(err)).toBe(false);
    noWrites();
  });

  it.each([
    ['a codeless dropped connection', new Error('Connection terminated unexpectedly')],
    ['a TypeError', new TypeError("Cannot read properties of undefined (reading 'rows')")],
    ['a plain "Company x not found"', new Error('Company 1 not found')],
  ])('%s is rethrown, not a refusal', async (_name, dbErr) => {
    vi.mocked(assertContraAccountUsable).mockRejectedValue(dbErr);
    const err = await run('ar').catch((e) => e);
    expect(err).toBe(dbErr);
    expect(isContraPreWriteRefusal(err)).toBe(false);
    noWrites();
  });

  it.each([
    ['the contra guards\' own code', Object.assign(guardRefusal('is a BANK account'), { code: 'CONTRA_SETTLEMENT_REFUSED' })],
    ['a foreign-currency refusal', Object.assign(new Error('USD invoice'), { code: 'FOREIGN_CURRENCY_SETTLEMENT' })],
    ['a missing system account', new MissingSystemAccountError('receivable', COMPANY)],
  ])('%s is a refusal', async (_name, guardErr) => {
    vi.mocked(loadContraDocument).mockRejectedValue(guardErr);
    const err = await run('ar').catch((e) => e);
    expect(err).toBeInstanceOf(ContraSettlementRefusal);
    expect(err.underlying).toBe(guardErr);
    noWrites();
  });

  it('an ApprovePermissionError thrown by a payment service AFTER a write is not a pre-write refusal', async () => {
    const late = new ApprovePermissionError('suppliers', 'supplier payments');
    vi.mocked(approveSupplierPayment).mockRejectedValue(late);
    const err = await run('ap').catch((e) => e);
    expect(err).toBe(late);
    expect(isContraPreWriteRefusal(err)).toBe(false);
  });

  it('the service\'s own refusals are recognised', async () => {
    vi.mocked(mayApprove).mockResolvedValue(false);
    expect(isContraPreWriteRefusal(await run('ar').catch((e) => e))).toBe(true);
  });
});

describe('atomic: the writes run in one savepoint', () => {
  it('success: SAVEPOINT then RELEASE, named settle_document_by_contra', async () => {
    await run('ap');
    expect(spLog).toEqual(['SAVEPOINT settle_document_by_contra', 'RELEASE settle_document_by_contra']);
  });

  it('a throw after create/approve rolls the savepoint back and propagates', async () => {
    vi.mocked(processSupplierPayment).mockRejectedValue(new Error('period closed'));
    await expect(run('ap')).rejects.toThrow(/period closed/);
    expect(createSupplierPayment).toHaveBeenCalled();
    expect(spLog).toEqual(['SAVEPOINT settle_document_by_contra', 'ROLLBACK TO settle_document_by_contra']);
  });

  it('a refusal before the writes opens no savepoint', async () => {
    vi.mocked(assertContraAccountUsable).mockRejectedValue(guardRefusal('is a BANK account'));
    await run('ar').catch(() => undefined);
    expect(spLog).toEqual([]);
  });
});
