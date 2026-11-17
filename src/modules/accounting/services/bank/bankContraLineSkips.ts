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
  for (const l of onBank) {
    const row = rowOf.get(l.txId.toLowerCase());
    if (!row) continue; // the row-state pass already skipped it
    if (String(row.bank).toLowerCase() === l.accountId.toLowerCase()) { skips.set(l.txId, OWN_BANK_CONTRA_MESSAGE); continue; }
    try {
      await assertNoDuplicateTransfer(companyId, String(row.bank), l.accountId, Number(row.amount),
        fmtDate(row.transaction_date as Date | string), isBankEvidenced(row));
    } catch (err) {
      if (!(err instanceof DuplicateTransferError)) throw err;
      skips.set(l.txId, err.message);
    }
  }
  return skips;
}
