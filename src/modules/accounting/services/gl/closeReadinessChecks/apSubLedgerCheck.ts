/**
 * AP sub-ledger to GL control account close-readiness check.
 *
 * Point-in-time: both sides are read AS AT the period end through
 * `reconcileSubledger(companyId, 'ap', endDate)` — the same settlement rewind
 * the aged creditors report uses — and the verdict is taken over its typed
 * reconciling items. Unapplied payments (item type `unapplied_receipt`, shared
 * with AR) and unapplied credit notes are tolerated; any other control-bridge
 * item — e.g. a bill whose journal is dated after the period end
 * (`document_not_on_control_account`) — fails the tie. See
 * subLedgerTieCheck.ts for the rules and the history.
 *
 * The control accounts are resolved by PAYABLE_SUBTYPES inside the
 * reconciliation (`payable`, `creditors`, `trade_payables`,
 * `accounts_payable`), and soft-deleted bills follow the K-053 as-at rule.
 */

import type { ChecklistItem } from '../periodCloseReadinessService';
import { subLedgerTieCheck } from './subLedgerTieCheck';

export { SUB_LEDGER_FAIL_THRESHOLD } from './subLedgerTieCheck';

export async function apSubLedgerCheck(
  companyId: string,
  period: { endDate: string },
): Promise<ChecklistItem> {
  return subLedgerTieCheck(companyId, period, {
    role: 'ap',
    key: 'ap_ties',
    label: 'AP sub-ledger ties to GL',
    fixHref: '/accounting/supplier-invoices',
    controlNoun: 'payable',
  });
}
