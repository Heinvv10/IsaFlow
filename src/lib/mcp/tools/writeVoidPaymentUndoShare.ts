/**
 * void_payment's step-6 arguments (2026-11-13): `undo_share` + `share_journal_id`, and `dry_run`.
 *
 * The undo itself — what a share is, every refusal, the journals — is `ap/voidPaymentUndoShare.ts` and
 * `ap/shareUndoPlan.ts`; the plan is built INSIDE the void by the service, never here, so nothing the caller sends can
 * stand in for it. A dry run runs the REAL call (void and undo) inside a savepoint that is always rolled back
 * (`core/rolledBackSavepoint`), so it meets every guard the live call meets and keeps nothing; it sets wroteNothing so
 * the idempotency key stays free for the live call. Nothing here catches: a throw must reach the registry's
 * savepoint, dry or live.
 */
import {
  voidPaymentDocument, type VoidPaymentResult, type VoidRefusal,
} from '@/modules/accounting/services/core/paymentVoidService';
import { voidPaymentUndoingShare, type VoidWithShareUndoResult } from '@/modules/accounting/services/ap/voidPaymentUndoShare';
import { inRolledBackSavepoint } from '@/modules/accounting/services/core/rolledBackSavepoint';
import type { McpToolContext, McpToolResult } from '../types';
import { mcpPostingOpts } from '../mcpActor';
import { guardCastableArgs, strArg, toolError } from './toolHelpers';

export const UNDO_SHARE_PROPERTIES = {
  undo_share: {
    type: 'boolean',
    description: 'Also undo the share a person took out of the contra\'s clearing account for each bill it settled: '
      + 'posts DR the bill\'s expense legs + VAT Input / CR the clearing account, per bill, dated on share_journal_id\'s '
      + 'date. Only for a contra payment (its journal credits a clearing account, not a bank). Requires share_journal_id.',
  },
  share_journal_id: {
    type: 'string',
    description: 'The posted journal that took the bills\' expense and VAT out of the clearing account (DR clearing / '
      + 'CR expense + VAT Input) — e.g. the month\'s re-dated share journal. It must debit the clearing account and '
      + 'credit every account the undo debits by at least the amounts undone, or the call is refused.',
  },
  dry_run: {
    type: 'boolean',
    description: 'Run the whole void (and undo) and roll it back: answers what would change, or the refusal the live '
      + 'call would give, and writes nothing.',
  },
} as const;

export type VoidOutcome = VoidPaymentResult | VoidWithShareUndoResult | VoidRefusal;

interface UndoArgs { undoShare: boolean; shareJournalId: string | null; dryRun: boolean }

/** The step-6 arguments, or the refusal — before any service call. */
export function parseUndoArgs(args: Record<string, unknown>): UndoArgs | McpToolResult {
  if (args.undo_share !== undefined && typeof args.undo_share !== 'boolean') {
    return toolError('undo_share must be true or false');
  }
  const undoShare = args.undo_share === true;
  const shareJournalId = strArg(args, 'share_journal_id') ?? null;
  if (undoShare && !shareJournalId) return toolError('share_journal_id is required when undo_share is true');
  if (!undoShare && shareJournalId) return toolError('share_journal_id is only used with undo_share: true');
  const bad = guardCastableArgs(args, { uuid: ['share_journal_id'] });
  if (bad) return bad;
  return { undoShare, shareJournalId, dryRun: args.dry_run === true };
}

/** Run the void (with the undo when asked), for real or inside a rolled-back savepoint. */
export async function runVoidPayment(
  ctx: McpToolContext, paymentId: string, reversalDate: string | undefined, a: UndoArgs,
): Promise<VoidOutcome> {
  const opts = { ...mcpPostingOpts(ctx, 'void_payment'), ...(reversalDate === undefined ? {} : { reversalDate }) };
  const run = (): Promise<VoidOutcome> => (a.undoShare
    ? voidPaymentUndoingShare(ctx.companyId, paymentId, a.shareJournalId!, ctx.userId, opts)
    : voidPaymentDocument(ctx.companyId, 'supplier', paymentId, ctx.userId, opts));
  if (!a.dryRun) return run();
  const held: { out?: VoidOutcome } = {};
  await inRolledBackSavepoint('mcp_void_payment_dry_run', async () => { held.out = await run(); });
  return held.out!;
}

export function hasUndoShare(r: VoidOutcome): r is VoidWithShareUndoResult {
  return 'undoShare' in r;
}

/** The reply's `undo_share` block; journal ids are null in a dry run (they were rolled back). */
export function undoShareReply(r: VoidWithShareUndoResult, dryRun: boolean) {
  const { plan, posted } = r.undoShare;
  const byBill = new Map(posted.map((p) => [p.billId, p]));
  return {
    share_journal_id: plan.shareJournal.id,
    share_entry_number: plan.shareJournal.entryNumber,
    entry_date: plan.shareJournal.entryDate,
    clearing_account: plan.clearingAccount,
    total: plan.total,
    journal_entry_ids: dryRun ? [] : posted.map((p) => p.journalEntryId),
    journals: plan.journals.map((j) => ({
      bill_id: j.billId,
      bill_number: j.billNumber,
      amount: j.amount,
      reference: j.reference,
      journal_entry_id: dryRun ? null : byBill.get(j.billId)?.journalEntryId ?? null,
      entry_number: dryRun ? null : byBill.get(j.billId)?.entryNumber ?? null,
      lines: j.lines.map((l) => ({
        account_id: l.glAccountId, debit: l.debit, credit: l.credit, vat_type: l.vatType ?? null,
        cc1_id: l.cc1Id ?? null, cc2_id: l.cc2Id ?? null, bu_id: l.buId ?? null, project_id: l.projectId ?? null,
      })),
    })),
  };
}
