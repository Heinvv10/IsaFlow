/**
 * void_payment's step-6 arguments: undo_share + share_journal_id, and dry_run.
 *
 * Pinned here: the arguments are validated before any service call; the undo goes through the service that plans it
 * inside the void (never a plan the tool built); the reply names every undo journal so reverse_journal_entry can take
 * each back; a dry run runs the REAL call inside an always-rolled-back savepoint (parity by construction), answers
 * the same refusals, and sets wroteNothing so the idempotency key stays free; a service throw is not caught.
 * The ledger itself is pinned in tests/integration/void-payment-undo-share.int.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/core/paymentVoidService', async () => {
  const actual = await vi.importActual<typeof import('@/modules/accounting/services/core/paymentVoidService')>(
    '@/modules/accounting/services/core/paymentVoidService');
  return { ...actual, voidPaymentDocument: vi.fn() };
});
vi.mock('@/modules/accounting/services/ap/voidPaymentUndoShare', () => ({ voidPaymentUndoingShare: vi.fn() }));
vi.mock('@/modules/accounting/services/core/rolledBackSavepoint', () => ({
  inRolledBackSavepoint: vi.fn(async (_name: string, fn: () => Promise<unknown>) => { await fn(); }),
}));

import { voidPaymentDocument } from '@/modules/accounting/services/core/paymentVoidService';
import { voidPaymentUndoingShare } from '@/modules/accounting/services/ap/voidPaymentUndoShare';
import { inRolledBackSavepoint } from '@/modules/accounting/services/core/rolledBackSavepoint';
import { voidPaymentTool, voidReceiptTool } from '@/lib/mcp/tools/writeVoidPayments';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const PAY = '77777777-7777-4777-8777-777777777777';
const SHARE = '99999999-9999-4999-8999-999999999999';
const KEY = { idempotency_key: 'k1' };
const ctx = { userId: USER, companyId: COMPANY, scopes: ['write:invoices', 'write:post'], tokenJti: 'jti', oauthAppId: null } as McpToolContext;

const VOIDED = {
  paymentId: PAY, paymentNumber: 'SP-2026-01861', kind: 'supplier' as const, invoicesReopened: 1, amountUnapplied: 7990,
  journalEntryId: 'je-pay', bankTransactionId: null, vatLockRoll: null,
};
const UNDONE = {
  ...VOIDED,
  undoShare: {
    plan: {
      paymentId: PAY, paymentNumber: 'SP-2026-01861', total: 7990, allocationRows: 1,
      clearingAccount: { id: 'x', code: '1560731', name: 'Bank Transfer acc - ABSA Paycards' },
      shareJournal: { id: SHARE, entryNumber: 'JE-2026-23854', entryDate: '2026-05-31' },
      journals: [{ billId: 'b1', billNumber: 'SIV1', amount: 7990, reference: `undo-share:${PAY}:b1`, description: 'd',
        lines: [{ glAccountId: 'e', debit: 6947.83, credit: 0 }, { glAccountId: 'v', debit: 1042.17, credit: 0, vatType: 'standard' },
          { glAccountId: 'x', debit: 0, credit: 7990 }] }],
    },
    posted: [{ billId: 'b1', billNumber: 'SIV1', amount: 7990, reference: `undo-share:${PAY}:b1`, journalEntryId: 'je-undo', entryNumber: 'JE-2026-29195' }],
  },
};

const body = (r: McpToolResult) => JSON.parse(r.content[0]!.text) as Record<string, any>;
const err = (r: McpToolResult) => { expect(r.isError).toBe(true); return r.content[0]!.text; };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(voidPaymentDocument).mockResolvedValue(VOIDED as never);
  vi.mocked(voidPaymentUndoingShare).mockResolvedValue(UNDONE as never);
});

describe('void_payment undo_share / dry_run', () => {
  it('declares undo_share, share_journal_id and dry_run on void_payment only', () => {
    const props = voidPaymentTool.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['undo_share', 'share_journal_id', 'dry_run']));
    expect(Object.keys(voidReceiptTool.inputSchema.properties as object)).not.toContain('undo_share');
  });

  it('refuses inconsistent or malformed undo arguments before any service call', async () => {
    expect(err(await voidPaymentTool.handler({ payment_id: PAY, undo_share: true, ...KEY }, ctx)))
      .toBe('share_journal_id is required when undo_share is true');
    expect(err(await voidPaymentTool.handler({ payment_id: PAY, share_journal_id: SHARE, ...KEY }, ctx)))
      .toBe('share_journal_id is only used with undo_share: true');
    expect(err(await voidPaymentTool.handler({ payment_id: PAY, undo_share: 'yes', share_journal_id: SHARE, ...KEY }, ctx)))
      .toBe('undo_share must be true or false');
    expect(err(await voidPaymentTool.handler({ payment_id: PAY, undo_share: true, share_journal_id: 'nope', ...KEY }, ctx)))
      .toBe('invalid share_journal_id');
    expect(voidPaymentDocument).not.toHaveBeenCalled();
    expect(voidPaymentUndoingShare).not.toHaveBeenCalled();
  });

  it('a plain void still goes straight to the void, with no hook', async () => {
    await voidPaymentTool.handler({ payment_id: PAY, ...KEY }, ctx);
    expect(voidPaymentUndoingShare).not.toHaveBeenCalled();
    expect(vi.mocked(voidPaymentDocument).mock.calls[0]![4]).not.toHaveProperty('beforeFirstWrite');
  });

  it('undo_share voids through the undo service, stamped, and names every undo journal', async () => {
    const out = body(await voidPaymentTool.handler(
      { payment_id: PAY, undo_share: true, share_journal_id: SHARE, reversal_date: '2026-09-30', ...KEY }, ctx));
    const call = vi.mocked(voidPaymentUndoingShare).mock.calls[0]!;
    expect(call.slice(0, 4)).toEqual([COMPANY, PAY, SHARE, USER]);
    expect(call[4]).toMatchObject({ reversalDate: '2026-09-30' });
    expect((call[4] as { postingAgent: string }).postingAgent).toContain('void_payment');
    expect(voidPaymentDocument).not.toHaveBeenCalled();
    expect(out).toMatchObject({ payment_id: PAY, voided: true, journal_entry_id: 'je-pay', amount_unapplied: 7990 });
    expect(out.undo_share).toMatchObject({
      share_journal_id: SHARE, share_entry_number: 'JE-2026-23854', entry_date: '2026-05-31',
      clearing_account: { id: 'x', code: '1560731', name: 'Bank Transfer acc - ABSA Paycards' },
      journal_entry_ids: ['je-undo'],
    });
    expect(out.undo_share.journals[0]).toMatchObject({
      bill_id: 'b1', bill_number: 'SIV1', amount: 7990, reference: `undo-share:${PAY}:b1`,
      journal_entry_id: 'je-undo', entry_number: 'JE-2026-29195',
    });
    expect(out.undo_share.journals[0].lines).toHaveLength(3);
    expect(out.reverse_with).toMatch(/reverse_journal_entry/);
  });

  it('dry_run runs the real call in a rolled-back savepoint, writes nothing and keeps the key free', async () => {
    const r = await voidPaymentTool.handler({ payment_id: PAY, undo_share: true, share_journal_id: SHARE, dry_run: true, ...KEY }, ctx);
    expect(inRolledBackSavepoint).toHaveBeenCalledTimes(1);
    expect(voidPaymentUndoingShare).toHaveBeenCalledTimes(1);
    expect(r.wroteNothing).toBe(true);
    const out = body(r);
    expect(out).toMatchObject({ dryRun: true, voided: false, would_void: true, journal_entry_id: 'je-pay' });
    expect(out.undo_share.journal_entry_ids).toEqual([]);
    expect(out.undo_share.journals[0]).toMatchObject({ bill_id: 'b1', journal_entry_id: null, entry_number: null });
  });

  it('dry_run of a plain void previews it the same way', async () => {
    const r = await voidPaymentTool.handler({ payment_id: PAY, dry_run: true, ...KEY }, ctx);
    expect(inRolledBackSavepoint).toHaveBeenCalledTimes(1);
    expect(r.wroteNothing).toBe(true);
    expect(body(r)).toMatchObject({ dryRun: true, would_void: true, invoices_reopened: 1 });
  });

  it('a dry run answers the live call\'s refusal, with no preview', async () => {
    vi.mocked(voidPaymentUndoingShare).mockResolvedValue({ refusal: 'already_cancelled' });
    const r = await voidPaymentTool.handler({ payment_id: PAY, undo_share: true, share_journal_id: SHARE, dry_run: true, ...KEY }, ctx);
    expect(err(r)).toBe('This document is already cancelled.');
    expect(r.wroteNothing).toBeUndefined();
  });

  it('does not catch a thrown refusal or failure, live or dry', async () => {
    vi.mocked(voidPaymentUndoingShare).mockRejectedValue(new Error('share journal does not credit 6100'));
    await expect(voidPaymentTool.handler({ payment_id: PAY, undo_share: true, share_journal_id: SHARE, ...KEY }, ctx))
      .rejects.toThrow('does not credit');
    await expect(voidPaymentTool.handler({ payment_id: PAY, undo_share: true, share_journal_id: SHARE, dry_run: true, ...KEY }, ctx))
      .rejects.toThrow('does not credit');
  });
});
