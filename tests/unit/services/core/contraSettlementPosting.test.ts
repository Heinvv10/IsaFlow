/**
 * contraSettlementPosting — the write half of the contra settlement, lifted out
 * of the MCP tool `settle_by_contra` for reuse by an intercompany worker.
 *
 * The posted journal must not change, so what is pinned is the composition: the
 * same services, in the same order, with the same arguments, and the actor's
 * ids landing on the right step (creator / approver / poster). And that every
 * refusal (approver permission, the guards, the R-035 gate) is thrown from inside
 * the service before the first write, whatever the caller did earlier.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const spLog: string[] = [];
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
import { agentNewSupplierPaymentRefusal } from '@/modules/accounting/services/gl/approvalUnattended';
import {
  loadContraSettlementContext,
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

beforeEach(() => {
  vi.resetAllMocks();
  spLog.length = 0;
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

describe('loadContraSettlementContext', () => {
  it('AR: DR contra / CR Accounts Receivable', async () => {
    vi.mocked(assertContraAccountUsable).mockResolvedValue(CONTRA_OK);
    vi.mocked(loadContraDocument).mockResolvedValue(DOCUMENT);
    vi.mocked(getSystemAccount).mockResolvedValue({ id: 'ctl', accountCode: '1120', accountName: 'Debtors' } as never);
    const c = await loadContraSettlementContext(COMPANY, 'ar', DOC, CONTRA, 400);
    expect(c.debit).toEqual({ id: CONTRA, code: '2400', name: 'Loan' });
    expect(c.credit).toEqual({ id: 'ctl', code: '1120', name: 'Debtors' });
    expect(getSystemAccount).toHaveBeenCalledWith('receivable', COMPANY);
    expect(loadContraDocument).toHaveBeenCalledWith(COMPANY, 'ar', DOC, 400);
  });

  it('AP: DR Accounts Payable / CR contra', async () => {
    vi.mocked(assertContraAccountUsable).mockResolvedValue(CONTRA_OK);
    vi.mocked(loadContraDocument).mockResolvedValue(DOCUMENT);
    vi.mocked(getSystemAccount).mockResolvedValue({ id: 'ctl', accountCode: '2000', accountName: 'Creditors' } as never);
    const c = await loadContraSettlementContext(COMPANY, 'ap', DOC, CONTRA, 400);
    expect(c.debit).toEqual({ id: 'ctl', code: '2000', name: 'Creditors' });
    expect(c.credit).toEqual({ id: CONTRA, code: '2400', name: 'Loan' });
    expect(getSystemAccount).toHaveBeenCalledWith('payable', COMPANY);
  });

  it('a refused contra account rejects with the guard\'s own error, before any payment service is touched', async () => {
    vi.mocked(assertContraAccountUsable).mockRejectedValue(new Error('2400 Loan is a BANK account.'));
    vi.mocked(loadContraDocument).mockResolvedValue(DOCUMENT);
    vi.mocked(getSystemAccount).mockResolvedValue({ id: 'ctl' } as never);
    await expect(loadContraSettlementContext(COMPANY, 'ar', DOC, CONTRA, 400)).rejects.toThrow(/BANK account/);
    expect(createCustomerPayment).not.toHaveBeenCalled();
  });

  it('a refused document (over-outstanding, cancelled) rejects with the guard\'s own error', async () => {
    vi.mocked(assertContraAccountUsable).mockResolvedValue(CONTRA_OK);
    vi.mocked(loadContraDocument).mockRejectedValue(new Error('R400.00 exceeds the R100.00 outstanding'));
    vi.mocked(getSystemAccount).mockResolvedValue({ id: 'ctl' } as never);
    await expect(loadContraSettlementContext(COMPANY, 'ar', DOC, CONTRA, 400)).rejects.toThrow(/exceeds/);
  });
});

describe('settleDocumentByContra', () => {
  it('AR: creates a contra receipt allocated to the invoice, then confirms it with the posting agent', async () => {
    const r = await run('ar');
    expect(createCustomerPayment).toHaveBeenCalledWith(COMPANY, {
      clientId: COUNTERPARTY, paymentDate: '2026-11-20', totalAmount: 400, paymentMethod: 'contra',
      bankAccountId: CONTRA, description: 'Contra settlement — Netted',
      allocations: [{ invoiceId: DOC, amount: 400 }],
    }, 'user-1');
    expect(confirmCustomerPayment).toHaveBeenCalledWith(COMPANY, PAYMENT, 'user-1', { postingAgent: 'system:test:v1' });
    expect(createSupplierPayment).not.toHaveBeenCalled();
    expect(r).toMatchObject({ paymentId: PAYMENT, paymentNumber: 'RCP1', journalEntryId: 'je-1' });
    expect(r.context.debit).toEqual({ id: CONTRA, code: '2400', name: 'Loan' });
  });

  it('AP: creates, approves (as the user) and processes (stamped) in that order', async () => {
    const order: string[] = [];
    vi.mocked(createSupplierPayment).mockImplementation(async () => { order.push('create'); return { id: PAYMENT } as never; });
    vi.mocked(approveSupplierPayment).mockImplementation(async () => { order.push('approve'); return { id: PAYMENT } as never; });
    vi.mocked(processSupplierPayment).mockImplementation(async () => {
      order.push('process'); return { id: PAYMENT, paymentNumber: 'PAY1', glJournalEntryId: 'je-2' } as never;
    });
    const r = await run('ap');
    expect(order).toEqual(['create', 'approve', 'process']);
    expect(createSupplierPayment).toHaveBeenCalledWith(COMPANY, {
      supplierId: COUNTERPARTY, paymentDate: '2026-11-20', totalAmount: 400, paymentMethod: 'contra',
      bankAccountId: CONTRA, description: 'Contra settlement — Netted',
      allocations: [{ invoiceId: DOC, amount: 400 }],
    }, 'user-1');
    expect(approveSupplierPayment).toHaveBeenCalledWith(COMPANY, PAYMENT, 'user-1');
    expect(processSupplierPayment).toHaveBeenCalledWith(COMPANY, PAYMENT, 'user-1', { postingAgent: 'system:test:v1' });
    expect(createCustomerPayment).not.toHaveBeenCalled();
    expect(r).toMatchObject({ paymentId: PAYMENT, paymentNumber: 'PAY1', journalEntryId: 'je-2' });
  });

  it('AP: a failed approval stops before process — no journal is posted', async () => {
    vi.mocked(approveSupplierPayment).mockRejectedValue(new Error('approval rule not cleared'));
    await expect(run('ap')).rejects.toThrow(/approval rule/);
    expect(processSupplierPayment).not.toHaveBeenCalled();
  });

  it('AR: a failed confirm propagates (nothing is swallowed)', async () => {
    vi.mocked(confirmCustomerPayment).mockRejectedValue(new Error('period closed'));
    await expect(run('ar')).rejects.toThrow(/period closed/);
  });

  it('a payment with no journal id reports null, not undefined', async () => {
    vi.mocked(confirmCustomerPayment).mockResolvedValue({ id: PAYMENT, paymentNumber: 'RCP1' } as never);
    expect((await run('ar')).journalEntryId).toBeNull();
  });
});

describe('every refusal comes before the first write, from inside the service', () => {
  it('a hand-forged input naming a BANK contra account cannot post: the guard re-runs and throws', async () => {
    vi.mocked(assertContraAccountUsable).mockRejectedValue(new Error('1000 FNB is a BANK account.'));
    for (const sub of ['ar', 'ap'] as const) {
      const err = await run(sub, { contraAccountId: 'bank-account-id' }).catch((e) => e);
      expect(err).toBeInstanceOf(ContraSettlementRefusal);
      expect(err.message).toMatch(/BANK account/);
      expect(err.underlying).toBeInstanceOf(Error);
    }
    expect(assertContraAccountUsable).toHaveBeenCalledWith(COMPANY, 'ar', 'bank-account-id');
    noWrites();
  });

  it('the subledger control account as contra cannot post', async () => {
    vi.mocked(assertContraAccountUsable).mockRejectedValue(new Error('1120 is the Accounts Receivable control account itself.'));
    await expect(run('ar')).rejects.toThrow(/control account itself/);
    noWrites();
  });

  it('an amount above the outstanding balance on the document, read now, cannot post', async () => {
    vi.mocked(loadContraDocument).mockRejectedValue(new Error('R400.00 exceeds the R100.00 outstanding'));
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

  it('R-035 is not asked for a receivable', async () => {
    await run('ar');
    expect(agentNewSupplierPaymentRefusal).not.toHaveBeenCalled();
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

  it.each(['', 'human:hein', 'user:hein', 'mcp:', 'agent:x:v1', 'MCP:x'])('postingAgent "%s" is refused', async (postingAgent) => {
    await expect(run('ar', { actor: { ...ACTOR, postingAgent } })).rejects.toBeInstanceOf(ContraSettlementRefusal);
    untouched();
  });

  it.each(['mcp:settle_by_contra:v1', 'ai:x:v1', 'system:ic-worker:v1', 'rule:r1'])('postingAgent "%s" is accepted', async (postingAgent) => {
    await expect(run('ar', { actor: { ...ACTOR, postingAgent } })).resolves.toBeDefined();
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

  it('a guard error carrying one of our refusal codes is still a refusal', async () => {
    vi.mocked(loadContraDocument).mockRejectedValue(Object.assign(new Error('FX refused'), { code: 'APPROVE_PERMISSION_REFUSED' }));
    expect(await run('ar').catch((e) => e)).toBeInstanceOf(ContraSettlementRefusal);
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
    vi.mocked(assertContraAccountUsable).mockRejectedValue(new Error('is a BANK account'));
    await run('ar').catch(() => undefined);
    expect(spLog).toEqual([]);
  });
});

describe('who calls settleDocumentByContra', () => {
  // It records an approval on a supplier payment, and its caller owns the authority question (mayApprove).
  // A new caller must be added here deliberately.
  it('only the MCP tool, until the intercompany worker is added on purpose', () => {
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src', 'pages'], { encoding: 'utf8' }).split('\n')
      .filter((f) => /\.tsx?$/.test(f));
    // The name anywhere (an aliased import, a re-export, a call) OR the module specifier (a namespace or dynamic import).
    const reaches = /\bsettleDocumentByContra\b|contraSettlementPosting['"`]/;
    const callers = files.filter((f) => reaches.test(readFileSync(f, 'utf8')));
    expect(callers.sort()).toEqual([
      'src/lib/mcp/tools/writeSettleByContra.ts',
      'src/modules/accounting/services/core/contraSettlementPosting.ts', // the definition
    ]);
  });
});
