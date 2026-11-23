/**
 * Intercompany P4-D, `acceptAllocation` with its reads mocked: the actor is the session user and is creator == approver; the person checks
 * (Login-as, write role, Approve) come before any row is read; the locks are taken in THE order; every refusal is stored as `failed` only AFTER
 * the clearing's savepoint was rolled back; anything else propagates with nothing stored; a stale preview is a 409 and the approver a 403,
 * neither stored.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  events: [] as string[],
  store: { client: {}, userId: 'u-1', companyId: 'co-1' } as Record<string, unknown> | undefined,
}));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (text.includes("set_config('lock_timeout'")) { m.events.push('bound'); return [{ prev: '0' }]; }
    if (text.includes('UPDATE customer_payments')) { m.events.push('stamp'); return [{ id: 'p-1' }]; }
    if (text.includes("SET status = 'accepted'")) { m.events.push('accepted'); return [{ id: 'm-1' }]; }
    if (text.includes("SET status = 'failed'")) { m.events.push('failed'); return [{ id: 'm-1' }]; }
    return [];
  }),
  withSavepoint: vi.fn(async (name: string, fn: () => Promise<unknown>) => {
    m.events.push(`savepoint:${name}`);
    try { const out = await fn(); m.events.push(`release:${name}`); return out; } catch (err) { m.events.push(`rollback:${name}`); throw err; }
  }),
}));
vi.mock('@/lib/als', () => ({ als: { getStore: () => m.store } }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const guard = vi.hoisted(() => ({ assertNotImpersonating: vi.fn() }));
vi.mock('@/lib/auth/impersonationGuard', () => guard);
const perm = vi.hoisted(() => ({ mayApprove: vi.fn(), approveRefusedMessage: () => 'no approve' }));
vi.mock('@/modules/accounting/services/core/approvePermission', () => perm);
const settle = vi.hoisted(() => {
  class ContraSettlementRefusal extends Error {}
  const refusals = new WeakSet<object>();
  return { ContraSettlementRefusal, refusals, settleDocumentByContra: vi.fn(), isContraPreWriteRefusal: (e: unknown) => typeof e === 'object' && e !== null && refusals.has(e) };
});
vi.mock('@/modules/accounting/services/core/contraSettlementPosting', () => settle);
const lock = vi.hoisted(() => ({ lockReceiptInvoices: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/receiptInvoiceLock', () => lock);
const reads = vi.hoisted(() => ({
  userCanWrite: vi.fn(), lockAllocationMessages: vi.fn(), lockConnection: vi.fn(), lockOwnSide: vi.fn(), lockLink: vi.fn(), askLive: vi.fn(),
  invoiceFacts: vi.fn(), pairCutover: vi.fn(), lockLoanAccount: vi.fn(), pendingDraftAmount: vi.fn(), clearedSoFar: vi.fn(),
}));
vi.mock('@/modules/accounting/services/intercompany/allocationClearReads', () => reads);
const dates = vi.hoisted(() => ({ todaySast: vi.fn(), postingDateRefusal: vi.fn() }));
vi.mock('@/modules/accounting/services/intercompany/allocationClearDate', () => dates);

import { acceptAllocation, IC_ALLOCATION_POSTING_AGENT } from '@/modules/accounting/services/intercompany/allocationClearService';
import { CLEAR_REFUSAL_SENTENCES } from '@/modules/accounting/services/intercompany/allocationClearRefusals';

const uid = (n: number) => `a0000000-0000-4000-8000-00000000000${n}`;
const LOAN = uid(1);
const INV = uid(2);
const payload = {
  version: 1, kind: 'allocation', allocationId: uid(3), amount: 400, currency: 'ZAR',
  payment: { id: uid(4), number: 'SP-1', reference: 'R', date: '2026-09-01', method: 'eft', cashLegIsLoanAccount: true },
  payerDocument: { type: 'supplier_invoice', id: uid(5), number: 'B-1' }, issuerDocument: { type: 'customer_invoice', id: INV }, linkId: uid(6), linkOrigin: 'mirror',
};
const input = { expectedLoanAccountId: LOAN, invoiceId: INV, amount: 400, postingDate: '2026-09-10' };
const call = (over: Partial<Parameters<typeof acceptAllocation>[0]> = {}) => acceptAllocation({ companyId: 'co-1', messageId: 'm-1', userId: 'u-1', input, ...over });
const record = <T>(name: string, value: T) => async () => { m.events.push(name); return value; };

beforeEach(() => {
  vi.clearAllMocks();
  m.events = [];
  m.store = { client: {}, userId: 'u-1', companyId: 'co-1' };
  guard.assertNotImpersonating.mockImplementation(record('impersonation', undefined));
  reads.userCanWrite.mockImplementation(record('canWrite', true));
  perm.mayApprove.mockImplementation(record('mayApprove', true));
  reads.lockAllocationMessages.mockImplementation(record('lock:message', { id: 'm-1', status: 'pending', fromCompanyId: 'co-2', connectionId: 'c-1', payload, sourceJournalEntryId: 'je-9' }));
  reads.lockConnection.mockImplementation(record('lock:connection', { id: 'c-1', status: 'active', kind: 'group', cutoverDate: '2026-01-01', lowId: 'co-1', highId: 'co-2' }));
  reads.lockOwnSide.mockImplementation(record('lock:side', { loanAccountId: LOAN, customerId: 'cust-1' }));
  reads.lockLink.mockImplementation(record('lock:link', undefined));
  reads.askLive.mockImplementation(record('live', { live: true, reason: 'ok', clearableTotal: 400, journalClearable: 400 }));
  lock.lockReceiptInvoices.mockImplementation(record('lock:invoice', new Map([[INV, { id: INV, invoiceNumber: 'INV-1', status: 'approved', deleted: false, totalCents: 115000, paidCents: 0, currencyCode: 'ZAR' }]])));
  reads.invoiceFacts.mockImplementation(record('invoice', { date: '2026-09-01', customerId: 'cust-1', currency: 'ZAR' }));
  reads.pairCutover.mockImplementation(record('cutover', '2026-01-01'));
  reads.lockLoanAccount.mockImplementation(record('lock:account', { accountType: 'asset', accountSubtype: 'other_current_asset', isActive: true, isParent: false, isSystem: false }));
  reads.pendingDraftAmount.mockImplementation(record('pending', 0));
  reads.clearedSoFar.mockImplementation(record('cleared', { byPayment: 0, byJournal: 0 }));
  dates.todaySast.mockResolvedValue('2026-11-23');
  dates.postingDateRefusal.mockImplementation(record('period', null));
  settle.settleDocumentByContra.mockImplementation(record('settle', { paymentId: 'p-1', paymentNumber: 'CP-1', journalEntryId: 'je-1' }));
});

describe('the actor and the person checks', () => {
  it('the actor must be the bound transaction\'s user of this company (a programming error, before anything)', async () => {
    m.store = { client: {}, userId: 'someone-else', companyId: 'co-1' };
    await expect(call()).rejects.toThrow(/not the session user/);
    m.store = undefined;
    await expect(call()).rejects.toThrow(/needs a request transaction/);
    expect(m.events).toEqual([]);
  });

  it('a Login-as session, no write role, no Approve: refused before any row is read (no lock, nothing stored)', async () => {
    guard.assertNotImpersonating.mockRejectedValueOnce(new Error('impersonating'));
    await expect(call()).rejects.toThrow('impersonating');
    expect(m.events).toEqual([]);
    reads.userCanWrite.mockImplementationOnce(record('canWrite', false));
    await expect(call()).rejects.toMatchObject({ status: 403 });
    expect(m.events).toEqual(['impersonation', 'canWrite']);
    m.events = [];
    perm.mayApprove.mockImplementationOnce(record('mayApprove', false));
    await expect(call()).rejects.toMatchObject({ status: 403 });
    expect(m.events).toEqual(['impersonation', 'canWrite', 'mayApprove']);
    expect(perm.mayApprove).toHaveBeenCalledWith('co-1', 'u-1', 'customers');
  });
});

describe('the clearing', () => {
  it('locks in THE order, checks everything, then posts once as the person (creator == approver), stamps, accepts', async () => {
    const out = await call();
    expect(out).toEqual({ accepted: true, messageId: 'm-1', paymentId: 'p-1', paymentNumber: 'CP-1', journalEntryId: 'je-1' });
    expect(m.events).toEqual([
      'impersonation', 'canWrite', 'mayApprove', 'bound', 'savepoint:ic_allocation_lock', 'lock:message', 'release:ic_allocation_lock',
      'savepoint:ic_allocation_clear', 'lock:connection', 'lock:side', 'lock:link', 'live', 'lock:invoice', 'invoice', 'cutover', 'lock:account',
      'pending', 'cleared', 'period', 'settle', 'stamp', 'accepted', 'release:ic_allocation_clear', 'bound',
    ]);
    expect(settle.settleDocumentByContra).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'co-1', subledger: 'ar', documentId: INV, contraAccountId: LOAN, amount: 400, date: '2026-09-10',
      actor: { userId: 'u-1', approverUserId: 'u-1', postingAgent: IC_ALLOCATION_POSTING_AGENT },
    }));
    expect(IC_ALLOCATION_POSTING_AGENT).toBe('system:ic_allocation_clear');
  });

  it('a refusal of a check is stored as failed AFTER the savepoint is rolled back, and nothing is posted', async () => {
    reads.askLive.mockImplementationOnce(record('live', { live: false, reason: 'allocation_gone', clearableTotal: null, journalClearable: null }));
    expect(await call()).toEqual({ accepted: false, messageId: 'm-1', status: 'failed', code: 'not_live', error: CLEAR_REFUSAL_SENTENCES.not_live });
    expect(m.events.slice(m.events.indexOf('live'))).toEqual(['live', 'rollback:ic_allocation_clear', 'failed', 'bound']);
    expect(settle.settleDocumentByContra).not.toHaveBeenCalled();
  });

  it.each([
    ['the cap', () => reads.clearedSoFar.mockImplementationOnce(record('cleared', { byPayment: 0.01, byJournal: 0 })), 'already_cleared'],
    ['the cash leg', () => reads.askLive.mockImplementationOnce(record('live', { live: true, reason: 'ok', clearableTotal: 0, journalClearable: 0 })), 'cash_not_through_loan'],
    ['the open amount with draft receipts', () => reads.pendingDraftAmount.mockImplementationOnce(record('pending', 750.01)), 'exceeds_open'],
    ['the cut-over (none for the pair)', () => reads.pairCutover.mockImplementationOnce(record('cutover', null)), 'pre_cutover_invoice'],
    ['the loan class', () => reads.lockLoanAccount.mockImplementationOnce(record('lock:account', { accountType: 'asset', accountSubtype: 'bank', isActive: true, isParent: false, isSystem: false })), 'loan_account_unusable'],
    ['the period', () => dates.postingDateRefusal.mockImplementationOnce(record('period', 'vat_locked')), 'vat_locked'],
    ['the customer', () => reads.invoiceFacts.mockImplementationOnce(record('invoice', { date: '2026-09-01', customerId: 'other', currency: 'ZAR' })), 'wrong_customer'],
  ])('%s refuses before the posting', async (_name, arrange, code) => {
    arrange();
    expect(await call()).toMatchObject({ accepted: false, code });
    expect(settle.settleDocumentByContra).not.toHaveBeenCalled();
    expect(m.events.at(-2)).toBe('failed');
  });

  it('a refusal code raised AFTER writes inside the posting (a receipt refusal) still rolls everything back first, then stores busy', async () => {
    settle.settleDocumentByContra.mockImplementationOnce(async () => { m.events.push('settle'); throw Object.assign(new Error('x'), { code: 'RECEIPT_REFUSED' }); });
    expect(await call()).toMatchObject({ accepted: false, code: 'busy' });
    expect(m.events.slice(m.events.indexOf('settle'))).toEqual(['settle', 'rollback:ic_allocation_clear', 'failed', 'bound']);
  });

  it('anything else propagates, nothing stored: a codeless error, a constraint (the guard), a statement timeout', async () => {
    for (const err of [new Error('boom'), Object.assign(new Error('guard'), { code: '23514' }), Object.assign(new Error('slow'), { code: '57014' })]) {
      m.events = [];
      settle.settleDocumentByContra.mockRejectedValueOnce(err);
      await expect(call()).rejects.toBe(err);
      expect(m.events).not.toContain('failed');
    }
  });

  it('the approver refused inside the posting is a 403, never stored; a slice-A contra refusal is stored as refused', async () => {
    const approve = Object.assign(new Error('no approve'), { code: 'APPROVE_PERMISSION_REFUSED' });
    settle.refusals.add(approve);
    settle.settleDocumentByContra.mockRejectedValueOnce(approve);
    await expect(call()).rejects.toMatchObject({ status: 403 });
    expect(m.events).not.toContain('failed');
    const contra = new settle.ContraSettlementRefusal('guard');
    settle.refusals.add(contra);
    settle.settleDocumentByContra.mockRejectedValueOnce(contra);
    expect(await call()).toMatchObject({ accepted: false, code: 'refused' });
  });

  it('a stale preview is a 409, a date before the payment or after today a 400: nothing stored', async () => {
    for (const over of [{ expectedLoanAccountId: uid(9) }, { invoiceId: uid(9) }, { amount: 399.99 }]) {
      m.events = [];
      await expect(call({ input: { ...input, ...over } })).rejects.toMatchObject({ status: 409 });
      expect(m.events).not.toContain('failed');
    }
    await expect(call({ input: { ...input, postingDate: '2026-08-31' } })).rejects.toMatchObject({ status: 400 });
    await expect(call({ input: { ...input, postingDate: '2026-11-24' } })).rejects.toMatchObject({ status: 400 });
    expect(settle.settleDocumentByContra).not.toHaveBeenCalled();
  });

  it('a message that is not this company\'s allocation is a 404, a handled one a 409; a held one a 409 (nothing stored)', async () => {
    reads.lockAllocationMessages.mockResolvedValueOnce(null);
    await expect(call()).rejects.toMatchObject({ status: 404 });
    reads.lockAllocationMessages.mockResolvedValueOnce({ id: 'm-1', status: 'accepted', fromCompanyId: 'co-2', connectionId: 'c-1', payload, sourceJournalEntryId: null });
    await expect(call()).rejects.toMatchObject({ status: 409 });
    reads.lockAllocationMessages.mockRejectedValueOnce(Object.assign(new Error('lock'), { code: '55P03' }));
    await expect(call()).rejects.toMatchObject({ status: 409 });
    expect(m.events).not.toContain('failed');
  });
});
