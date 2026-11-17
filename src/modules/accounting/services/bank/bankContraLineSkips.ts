/**
 * The bulk allocator's batch pre-check for ACCOUNT lines onto a bank account (MCP bulk_allocate_bank_transactions,
 * WP2 row 5 round 2): what allocateTransaction would refuse, as per-line skips, read-only — so one bad line is a skip
 * instead of unwinding the good lines beside it, and `dry_run` reports exactly what the live call skips.
 *
 *  - the line's OWN bank as the contra: refused (`OWN_BANK_CONTRA_MESSAGE`);
 *  - another bank, whose movement the ledger already holds (`assertNoDuplicateTransfer`, read-only): the live arm
 *    re-asks under the pair lock, so this is the same answer read before the lock.
 *
 * Not decidable here: a duplicate the SAME batch creates (an earlier line posting the other leg). The live call skips
 * it as a duplicate; the dry run cannot see it (said in the tool's preview caveats).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { isBankEvidenced } from '../ap/bankLinePaymentGate';
import { OWN_BANK_CONTRA_MESSAGE, bankAccountsAmong } from './bankContraTransfer';
import { DuplicateTransferError, assertNoDuplicateTransfer } from './transferDuplicateGuard';

/** The dry run's caveat when the batch posts a transfer: the one duplicate it cannot see. */
export const TRANSFER_DRY_RUN_CAVEAT = 'Lines onto another bank account post as transfers. A transfer already in the '
  + 'ledger is skipped above; one that an EARLIER line of this same batch posts (the other bank\'s leg) is not '
  + 'previewable; the live call skips it (already allocated by the auto-link, or a duplicate).';

/** Does the batch post any transfer (an account line onto a bank account)? The dry run's caveat; one read. */
export async function batchPostsTransfers(companyId: string, accountIds: readonly string[]): Promise<boolean> {
  return (await bankAccountsAmong(companyId, accountIds)).size > 0;
}

export async function bankContraLineSkips(
  companyId: string, lines: readonly { txId: string; accountId: string }[],
): Promise<Map<string, string>> {
  const skips = new Map<string, string>();
  const banks = await bankAccountsAmong(companyId, lines.map((l) => l.accountId));
  const onBank = lines.filter((l) => banks.has(l.accountId.toLowerCase()));
  if (onBank.length === 0) return skips;
  const rows = (await sql`
    SELECT id::TEXT AS id, bank_account_id::TEXT AS bank, amount, transaction_date, bank_feed_connection_id, import_batch_id
    FROM bank_transactions
    WHERE company_id = ${companyId}::UUID AND id = ANY(${onBank.map((l) => l.txId)}::UUID[])
  `) as DbRow[];
  const rowOf = new Map(rows.map((r) => [String(r.id).toLowerCase(), r]));
  // #1494 rev 6, a documented decision: the duplicate read stays the live arm's own `assertNoDuplicateTransfer` (one
  // source of truth for a 100-line rule — a set-based twin would drift from it), asked only for lines onto ANOTHER bank
  // (not the batch), and once per distinct movement: lines of one bank, counterparty, amount, date and evidence share
  // the answer, so a batch of identical sweeps costs one read.
  const answers = new Map<string, Promise<string | null>>();
  const duplicateOf = (row: DbRow, contra: string) => {
    const date = fmtDate(row.transaction_date as Date | string);
    const key = [String(row.bank).toLowerCase(), contra.toLowerCase(), Number(row.amount), date, isBankEvidenced(row)].join('|');
    if (!answers.has(key)) {
      answers.set(key, assertNoDuplicateTransfer(companyId, String(row.bank), contra, Number(row.amount), date, isBankEvidenced(row))
        .then(() => null, (err: unknown) => { if (err instanceof DuplicateTransferError) return err.message; throw err; }));
    }
    return answers.get(key)!;
  };
  for (const l of onBank) {
    const row = rowOf.get(l.txId.toLowerCase());
    if (!row) continue; // the row-state pass already skipped it
    if (String(row.bank).toLowerCase() === l.accountId.toLowerCase()) { skips.set(l.txId, OWN_BANK_CONTRA_MESSAGE); continue; }
    const duplicate = await duplicateOf(row, l.accountId); // sequential: one pg connection
    if (duplicate) skips.set(l.txId, duplicate);
  }
  return skips;
}
