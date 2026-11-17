/**
 * The pre-lock of a request that posts SEVERAL transfer journals (the confidence gate, MCP bulk allocate — WP2 row 5):
 * the single path's order, line → pair → number, taken for the whole batch before its first journal.
 *
 *  1. the batch's transfer LINES (an account contra that is another bank), in id order, each in its own savepoint;
 *  2. their PAIRS, sorted (`preLockTransferPairs`);
 *  3. then the loop posts, and each journal takes the number lock.
 *
 * Without (1) the batch held a pair while a single allocation of one of its lines held that line and waited on the
 * pair; without (2) it held the number lock from journal N while it waited on pair N+1 (transferPairLock's header).
 * A line or pair another request holds past its budget — or a deadlock victim — is CONTENDED: its row is skipped and
 * counted retryable, never attempted (an attempt would wait on it holding the number lock). Decided by the lock's
 * outcome, each in a savepoint, so the request stays usable.
 */
import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { bankAccountsAmong } from './bankContraTransfer';
import { lockBankTransactionForUpdate } from './bankTxLock';
import { isContendedLock, preLockTransferPairs, remainingWaitMs, transferPairKey } from './transferPairLock';

export interface SweepTransferLocks {
  /** Rows that post as a transfer (an account contra that is ANOTHER bank account). */
  transfers: Set<string>;
  /** Transfer rows whose line or pair another request holds: skip, retryable. */
  contended: Set<string>;
}

/** `rows`: the batch's rows that WILL be attempted (past every pure check), each with its account contra. */
export async function preLockSweepTransfers(
  companyId: string, rows: readonly { id: string; contra: string | null | undefined }[],
): Promise<SweepTransferLocks> {
  const transfers = new Set<string>();
  const contended = new Set<string>();
  const banks = await bankAccountsAmong(companyId, rows.map((r) => r.contra ?? ''));
  const onBank = rows.filter((r) => r.contra && banks.has(r.contra.toLowerCase()));
  if (onBank.length === 0) return { transfers, contended };
  const lines = (await sql`
    SELECT id::TEXT AS id, bank_account_id::TEXT AS bank FROM bank_transactions
    WHERE company_id = ${companyId}::UUID AND id = ANY(${onBank.map((r) => r.id)}::UUID[])
  `) as DbRow[];
  const bankOf = new Map(lines.map((l) => [String(l.id).toLowerCase(), String(l.bank)]));
  const pairs: Array<[string, [string, string]]> = []; // a line two rules name (two contras) carries both pairs
  for (const r of onBank) {
    const bank = bankOf.get(r.id.toLowerCase());
    if (bank && bank.toLowerCase() !== r.contra!.toLowerCase()) { transfers.add(r.id); pairs.push([r.id, [bank, r.contra!]]); }
  }
  // ONE budget for the whole pre-lock, lines and pairs (brk-1494 LOW 2): each waits what is left of 5 s, then 1 ms.
  const deadline = Date.now() + 5000;
  for (const id of [...transfers].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1))) {
    try {
      await withSavepoint('transfer_line_prelock', () => lockBankTransactionForUpdate(companyId, id,
        { lockTimeoutMs: remainingWaitMs(deadline) }));
    } catch (err) {
      if (!isContendedLock(err)) throw err;
      contended.add(id);
    }
  }
  const held = await preLockTransferPairs(companyId, pairs.filter(([id]) => !contended.has(id)).map(([, p]) => p), deadline);
  for (const [id, [a, b]] of pairs) if (held.has(transferPairKey(companyId, a, b))) contended.add(id);
  return { transfers, contended };
}
