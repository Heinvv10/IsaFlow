/**
 * The MCP batch and range reversals (reverse_bank_allocation_batch, reverse_allocations) and a transfer's OTHER leg —
 * the line the transfer auto-linked outside the batch / range, which reverseReconciledTransaction resets with each line
 * (WP2 row 10, transferLegReset). Asked of the whole call BEFORE its first reversal (#1494 follow-ups M1 + brk):
 *
 *  - `counterpartRefusal` (read-only, so the range's dry run gives the same answer as the live call): a counterpart a
 *    reconciliation holds refuses the call before any write, where it used to fail at that line mid-call;
 *  - `preLockReversalLines`: every line and every counterpart locked in ONE id order (sessions first), so a single
 *    reverse of a counterpart (which locks {line, leg} in id order) cannot cross the call's per-line locks.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { lockBankTransactionsInIdOrder } from './bankTxLock';
import { reconciliationLockOf, refuseLockedCash } from './reconciledCash';
import { OTHER_LEG, otherLegs } from './transferLegReset';
import { peekLineChain } from './bankChainLineReversal';

/**
 * The other live legs of every line in `lineIds`, outside the call — by the SAME rule reverseReconciledTransaction's
 * leg reset uses (transferLegReset.otherLegs: the chain head's `liveLinesLosingCash`; a document chain has none), so
 * the pre-lock and the refusal cover exactly the lines each reversal will reset (#1545 r2 LOW 2). Unlocked rows.
 */
export async function counterpartRows(companyId: string, lineIds: readonly string[]): Promise<DbRow[]> {
  const inCall = new Set(lineIds.map((id) => id.toLowerCase()));
  const legs = new Set<string>();
  for (const id of lineIds) {
    for (const leg of await otherLegs(companyId, id, await peekLineChain(companyId, id))) {
      if (!inCall.has(leg.toLowerCase())) legs.add(leg.toLowerCase());
    }
  }
  if (legs.size === 0) return [];
  return (await sql`
    SELECT id::TEXT AS id, status, reconciliation_id FROM bank_transactions
    WHERE company_id = ${companyId}::UUID AND id = ANY(${[...legs]}::UUID[]) ORDER BY 1
  `) as DbRow[];
}

/** The refusal the call would meet at a counterpart a reconciliation holds, or null. Read-only. */
export async function counterpartRefusal(companyId: string, lineIds: readonly string[]): Promise<string | null> {
  for (const leg of await counterpartRows(companyId, lineIds)) {
    try {
      refuseLockedCash(await reconciliationLockOf(companyId, leg), OTHER_LEG);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
  return null;
}

/**
 * Before the first reversal: the lines and their counterparts, locked together in id order, sessions first, under ONE
 * 5 s deadline for the whole set (#1545 r2 LOW 3), not 5 s per line.
 */
export async function preLockReversalLines(companyId: string, lineIds: readonly string[]): Promise<void> {
  const legs = await counterpartRows(companyId, lineIds);
  await lockBankTransactionsInIdOrder(companyId, [...lineIds, ...legs.map((l) => String(l.id))], { deadline: Date.now() + 5000 });
}
