/**
 * reallocate_bank_transaction: the tool's own half — argument refusals before any service call, tenant ownership,
 * the posting stamp, dry run == live (the SAME service call, run inside an always-rolled-back savepoint), and no
 * catch after the write (a service refusal propagates to the registry's savepoint). The service's refusals and the
 * ledger effect are in tests/unit/services/bank/bankReallocationGuards.test.ts and
 * tests/integration/bank-reallocate-reconciled.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/accounting/services/bank/bankReallocationService', () => ({ reallocateReconciledTransaction: vi.fn() }));
vi.mock('@/modules/accounting/services/core/rolledBackSavepoint', () => ({
  inRolledBackSavepoint: vi.fn(async (_name: string, fn: () => Promise<unknown>) => { await fn(); }),
}));
vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', () => ({ accountsBelongToCompany: vi.fn() }));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({
  customersBelongToCompany: vi.fn(), suppliersBelongToCompany: vi.fn(),
}));
vi.mock('@/lib/mcp/tools/allocationVatGuard', () => ({ resolveLineVatCode: vi.fn() }));
vi.mock('@/lib/mcp/tools/dimensionArgs', async (orig) => ({
  ...(await orig<typeof import('@/lib/mcp/tools/dimensionArgs')>()),
  attachLineDimensionIds: vi.fn(async () => null),
  dimensionWarningsOrRefusal: vi.fn(async () => ({ warnings: [] })),
}));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));

import { reallocateReconciledTransaction } from '@/modules/accounting/services/bank/bankReallocationService';
import { BankReallocationRefusal } from '@/modules/accounting/services/bank/bankReallocationGuards';
import { inRolledBackSavepoint } from '@/modules/accounting/services/core/rolledBackSavepoint';
import { accountsBelongToCompany } from '@/modules/accounting/services/gl/chartOfAccountsService';
import { customersBelongToCompany, suppliersBelongToCompany } from '@/modules/accounting/services/core/contactDirectoryService';
import { resolveLineVatCode } from '@/lib/mcp/tools/allocationVatGuard';
import { dimensionWarningsOrRefusal } from '@/lib/mcp/tools/dimensionArgs';
import { reallocateBankTransactionTool as tool } from '@/lib/mcp/tools/writeBankReallocate';
import { isRefusalCoded } from '@/lib/mcp/tools/toolHelpers';

const ctx = { companyId: 'company-1', userId: 'user-1', tokenJti: 'jti', oauthAppId: null } as never;
const TX = '045ef594-d81d-4f21-84d6-1151ed71260d';
const JE = '97120700-9f09-4fe5-804e-34331ce49b97';
const ACCT = 'cf9df9b9-9fc0-424b-8137-47e9ba144c73';
const SUP = 'd0ac03be-abe5-44c4-80a2-0d99d9d3e3e6';
const base = { transaction_id: TX, expected_journal_entry_id: JE, idempotency_key: 'k1' };
const text = (r: { content: Array<{ text: string }> }) => r.content[0]!.text;
const RESULT = {
  outcome: 'reallocated', transactionId: TX, reconciliationId: 'rec-1', originalJournalEntryId: JE,
  reversalJournalEntryId: 'rev-1', newJournalEntryId: 'new-1', entryDate: '2026-06-10',
  bankLeg: { accountId: 'bank-1', amount: -100, oldLineId: 'l-old', newLineId: 'l-new' },
  unwound: { invoicesReopened: 0, amountUnapplied: 0, paymentsCancelled: 0 },
  newDocument: { kind: 'supplier_payment', paymentId: 'pay-1' },
  application: { autoApply: 'fifo', applications: [{ documentId: 'bill-1', documentNumber: 'B1', amount: 100 }], onAccount: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(accountsBelongToCompany).mockResolvedValue(true);
  vi.mocked(suppliersBelongToCompany).mockResolvedValue(true);
  vi.mocked(customersBelongToCompany).mockResolvedValue(true);
  vi.mocked(resolveLineVatCode).mockImplementation(async (_c, _t, line) => ({ effectiveVatCode: line.vatCode }));
  vi.mocked(reallocateReconciledTransaction).mockResolvedValue(RESULT as never);
});

describe('reallocate_bank_transaction', () => {
  it('posts: write:bank-tx with write:post, free of metering by being a correction, dry_run and the key required', () => {
    expect(tool).toMatchObject({ name: 'reallocate_bank_transaction', scope: 'write:bank-tx', write: true, requiresPost: true });
    expect(tool.inputSchema.required).toEqual(
      expect.arrayContaining(['transaction_id', 'expected_journal_entry_id', 'target', 'dry_run', 'idempotency_key']));
    expect(tool.inputSchema.additionalProperties).toBe(false);
  });

  it.each([
    [{ ...base, dry_run: false }, /target/],
    [{ ...base, dry_run: false, target: {} }, /exactly one/],
    [{ ...base, dry_run: false, target: { gl_account_id: ACCT, supplier_id: SUP } }, /exactly one/],
    [{ ...base, dry_run: false, target: { gl_account_id: 'nope' } }, /invalid gl_account_id/],
    [{ ...base, dry_run: false, target: { gl_account_id: ACCT, extra: 1 } }, /exactly one/],
    [{ ...base, target: { gl_account_id: ACCT } }, /dry_run/],
    [{ transaction_id: TX, idempotency_key: 'k', dry_run: false, target: { gl_account_id: ACCT } }, /expected_journal_entry_id/],
    [{ ...base, expected_journal_entry_id: 'x', dry_run: false, target: { gl_account_id: ACCT } }, /invalid expected_journal_entry_id/],
    [{ ...base, transaction_id: 'x', dry_run: false, target: { gl_account_id: ACCT } }, /invalid transaction_id/],
    [{ ...base, dry_run: false, target: { gl_account_id: ACCT }, vat_type: 'zero-rated' }, /vat_type/],
    [{ ...base, dry_run: false, target: { supplier_id: SUP }, cc2: 'P1' }, /carries no cc1\/cc2\/bu/],
    [{ ...base, dry_run: false, target: { supplier_id: SUP }, auto_apply: 'all' }, /auto_apply/],
    [{ ...base, dry_run: false, target: { supplier_id: SUP }, invoice_id: SUP }, /invoice/],
  ])('refuses a malformed call before the service: %j', async (args, pattern) => {
    const r = await tool.handler(args as Record<string, unknown>, ctx);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(pattern);
    expect(reallocateReconciledTransaction).not.toHaveBeenCalled();
  });

  it('a target of another company is the generic not-found, before the service', async () => {
    vi.mocked(suppliersBelongToCompany).mockResolvedValue(false);
    const r = await tool.handler({ ...base, dry_run: false, target: { supplier_id: SUP } }, ctx);
    expect(text(r)).toBe('Not found');
    expect(reallocateReconciledTransaction).not.toHaveBeenCalled();
  });

  it('live: tenant and actor from ctx, stamped mcp:reallocate_bank_transaction:v1, and answers every id', async () => {
    const r = await tool.handler({ ...base, dry_run: false, target: { supplier_id: SUP } }, ctx);
    expect(reallocateReconciledTransaction).toHaveBeenCalledWith('company-1', TX, 'user-1',
      { kind: 'supplier', supplierId: SUP },
      expect.objectContaining({
        postingAgent: 'mcp:reallocate_bank_transaction:v1', actorType: 'agent', actorTokenJti: 'jti',
        expectedJournalEntryId: JE, autoApply: 'fifo',
      }));
    expect(inRolledBackSavepoint).not.toHaveBeenCalled();
    expect(r.wroteNothing).toBeUndefined();
    const body = JSON.parse(text(r));
    expect(body).toMatchObject({
      transaction_id: TX, reconciliation_id: 'rec-1', reconciliation_unchanged: true, original_journal_entry_id: JE,
      reversal_journal_entry_id: 'rev-1', new_journal_entry_id: 'new-1', entry_date: '2026-06-10',
      bank_leg: { account_id: 'bank-1', amount: -100, old_line_id: 'l-old', new_line_id: 'l-new' },
      new_document: { kind: 'supplier_payment', payment_id: 'pay-1' },
      applications: [{ document_id: 'bill-1', document_number: 'B1', amount: 100 }], on_account: 0,
    });
    expect(body.dry_run).toBeUndefined();
  });

  it('an account target passes the account, the VAT code (as the VAT guard left it) and the dimensions', async () => {
    vi.mocked(resolveLineVatCode).mockResolvedValue({
      effectiveVatCode: 'none', vatCoerced: { from: 'standard', to: 'none', reason: 'no_supply' } });
    const r = await tool.handler({ ...base, dry_run: false, target: { gl_account_id: ACCT }, vat_type: 'standard' }, ctx);
    const call = vi.mocked(reallocateReconciledTransaction).mock.calls[0]!;
    expect(call[3]).toEqual({ kind: 'account', glAccountId: ACCT });
    expect(call[4]).toMatchObject({ vatType: 'none' });
    expect(JSON.parse(text(r)).vat_coerced).toEqual({ from: 'standard', to: 'none', reason: 'no_supply' });
    expect(dimensionWarningsOrRefusal).toHaveBeenCalled();
  });

  it('dry run: the SAME service call inside a rolled-back savepoint; wroteNothing frees the key for the live call', async () => {
    const args = { ...base, target: { gl_account_id: ACCT } };
    const dry = await tool.handler({ ...args, dry_run: true }, ctx);
    expect(inRolledBackSavepoint).toHaveBeenCalledTimes(1);
    expect(dry.wroteNothing).toBe(true);
    expect(dry.billable).toBe(false);
    expect(JSON.parse(text(dry))).toMatchObject({ dry_run: true, new_journal_entry_id: 'new-1' });
    const live = await tool.handler({ ...args, dry_run: false }, ctx);
    expect(live.isError).toBeUndefined();
    const [dryCall, liveCall] = vi.mocked(reallocateReconciledTransaction).mock.calls;
    expect(dryCall).toEqual(liveCall);
  });

  it('dry run and live meet the same refusal, thrown (never caught into a tool error after the write)', async () => {
    const refusal = new BankReallocationRefusal('expected_journal_entry_id does not match');
    vi.mocked(reallocateReconciledTransaction).mockRejectedValue(refusal);
    const args = { ...base, target: { gl_account_id: ACCT } };
    await expect(tool.handler({ ...args, dry_run: true }, ctx)).rejects.toBe(refusal);
    await expect(tool.handler({ ...args, dry_run: false }, ctx)).rejects.toBe(refusal);
    expect(isRefusalCoded(refusal)).toBe(true); // the registry shows its message after rolling the savepoint back
  });

  it('the same target is nothing_changed and writes nothing (key freed, not billed)', async () => {
    vi.mocked(reallocateReconciledTransaction).mockResolvedValue({
      ...RESULT, outcome: 'nothing_changed', reversalJournalEntryId: null, newJournalEntryId: null,
      bankLeg: { ...RESULT.bankLeg, newLineId: null }, newDocument: { kind: 'none', paymentId: null }, application: undefined,
    } as never);
    const r = await tool.handler({ ...base, dry_run: false, target: { gl_account_id: ACCT } }, ctx);
    expect(r.wroteNothing).toBe(true);
    expect(JSON.parse(text(r))).toMatchObject({ nothing_changed: true, new_journal_entry_id: null });
  });
});
