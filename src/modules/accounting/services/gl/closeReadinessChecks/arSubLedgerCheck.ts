/**
 * AR sub-ledger to GL control account close-readiness check.
 *
 * Point-in-time: both sides are read AS AT the period end through
 * `reconcileSubledger(companyId, 'ar', endDate)` — the same settlement rewind
 * the aged debtors report uses — and the verdict is taken over its typed
 * reconciling items. Unapplied receipts and unapplied credit notes are
 * tolerated; any other control-bridge item fails the tie. See
 * subLedgerTieCheck.ts for the rules and the history (the old current-balance
 * sum read R0.00 for every past period on books that tie).
 *
 * The control accounts are resolved by RECEIVABLE_SUBTYPES inside the
 * reconciliation (`receivable`, `debtors`, `trade_receivables`,
 * `accounts_receivable`), and soft-deleted invoices follow the K-053 as-at
 * rule there too.
 */

import type { ChecklistItem } from '../periodCloseReadinessService';
import { subLedgerTieCheck } from './subLedgerTieCheck';

export { SUB_LEDGER_FAIL_THRESHOLD } from './subLedgerTieCheck';

export async function arSubLedgerCheck(
  companyId: string,
  period: { endDate: string },
): Promise<ChecklistItem> {
  return subLedgerTieCheck(companyId, period, {
    role: 'ar',
    key: 'ar_ties',
    label: 'AR sub-ledger ties to GL',
    fixHref: '/accounting/customer-invoices',
    controlNoun: 'receivable',
  });
}
