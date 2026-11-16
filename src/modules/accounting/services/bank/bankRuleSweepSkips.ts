/**
 * Which counted skip a rule-sweep line's throw is (moved out of bankRulesMatchingService.applyRules, its line cap).
 * Every member reaches the sweep through the line's savepoint, which has rolled back cleanly, so the request
 * transaction is still live: a skip the run reports. Null: a real failure, rethrown.
 */
import { isRetryableContention } from '../core/retryableContention';
import { isHeldRowError } from '@/lib/lockTimeout';
import { VatPeriodLockedError } from '../gl/journalVatLockGuard';
import { isHeaderAccountRefusal } from '../gl/headerAccountGuard';
import { isSupplierRefundRefusal } from '../ap/supplierRefundDocument';
import { transferRuleSkip } from './bankRuleTransferLine';

export type SweepLineSkip =
  | 'vat_locked' | 'header_account' | 'refund_ceiling' | 'locked' | 'duplicate_transfer' | 'approval_required'
  | 'closed_period';

export function sweepLineSkip(lineErr: unknown): SweepLineSkip | null {
  // createJournalEntry refuses a VAT-moving line dated in a locked VAT period before its draft exists; the line's
  // savepoint has rolled back cleanly, so it is a skip like a closed period, not a failure.
  if (lineErr instanceof VatPeriodLockedError) return 'vat_locked';
  // Refused before its draft exists, like the VAT lock: a skip the run reports, never a run-wide abort.
  if (isHeaderAccountRefusal(lineErr)) return 'header_account';
  if (isSupplierRefundRefusal(lineErr)) return 'refund_ceiling'; // AP or AR refund ceiling
  // WP2 row 5: a transfer rule's movement already in the ledger, or a line an enforced rule / the importer control
  // holds (allocateTransaction's own refusals, from reads before the first write).
  const transfer = transferRuleSkip(lineErr);
  if (transfer) return transfer;
  // Another request is holding this row. One contended transaction must not abort a run that has already posted for
  // earlier ones — the route's catch would 400 while withAuth still COMMITted them. Counted and retryable.
  //
  // The UNION, not the bank-line lock alone: a supplier rule also reaches `recordSupplierBankPayment`, whose plan
  // phase raises the payment-lock timeout and the `retryable` refusal for a held bill. Those surface HERE through a
  // savepoint that rolled back cleanly, so the request transaction is still live and re-throwing them committed the
  // earlier lines behind the route's 400 — measured, every bill held: 400 "Action failed", line A posted and
  // committed, line B still imported. ...and every other held-row event (D11 `isHeldRowError`), the raw 55P03 above
  // all: since migration 858 the line's journal number waits on the company+year number lock, bounded at 5 s, and a
  // peer that holds it longer fails the line with a raw 55P03 — through this same rolled-back savepoint.
  if (isRetryableContention(lineErr) || isHeldRowError(lineErr)) return 'locked';
  return null;
}
