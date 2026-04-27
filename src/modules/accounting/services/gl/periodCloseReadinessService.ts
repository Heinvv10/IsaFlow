/**
 * Period Close Readiness Service — orchestrator
 *
 * Runs 6 parallel advisory checks to determine whether a fiscal period is
 * ready to close.  Each check is isolated: one failing check cannot blank the
 * whole panel (Promise.allSettled).
 *
 *   1. bank_reconciled   — all bank txns in period are reconciled or excluded
 *   2. unposted_journals — all journal entries in period are posted
 *   3. ar_ties           — AR sub-ledger ties to GL receivable control account
 *   4. ap_ties           — AP sub-ledger ties to GL payable control account
 *   5. vat_reviewed      — a VAT return covers this period
 *   6. tb_balanced       — sum(debits) == sum(credits) for posted entries
 *
 * All checks are ADVISORY — they do not block period close.
 * Every SQL query is scoped by company_id (multi-tenant safe).
 */

import { log } from '@/lib/logger';
import { getFiscalPeriodById } from './fiscalPeriodService';
import { bankReconciledCheck } from './closeReadinessChecks/bankReconciledCheck';
import { unpostedJournalsCheck } from './closeReadinessChecks/unpostedJournalsCheck';
import { arSubLedgerCheck } from './closeReadinessChecks/arSubLedgerCheck';
import { apSubLedgerCheck } from './closeReadinessChecks/apSubLedgerCheck';
import { vatReviewedCheck } from './closeReadinessChecks/vatReviewedCheck';
import { tbBalancedCheck } from './closeReadinessChecks/tbBalancedCheck';

// ── Shared types (imported by check files) ───────────────────────────────────

export type ChecklistItemStatus = 'pass' | 'fail' | 'warn';

export type ChecklistItemKey =
  | 'bank_reconciled'
  | 'unposted_journals'
  | 'ar_ties'
  | 'ap_ties'
  | 'vat_reviewed'
  | 'tb_balanced';

export interface ChecklistItem {
  key: ChecklistItemKey;
  label: string;
  status: ChecklistItemStatus;
  reason: string;
  fixHref: string;
}

export interface CloseReadiness {
  periodId: string;
  periodLabel: string;
  items: ChecklistItem[];
  overallStatus: ChecklistItemStatus;
}

// ── Fallback metadata for rejected checks ────────────────────────────────────

const CHECK_KEYS: ChecklistItemKey[] = [
  'bank_reconciled',
  'unposted_journals',
  'ar_ties',
  'ap_ties',
  'vat_reviewed',
  'tb_balanced',
];

const CHECK_LABELS: string[] = [
  'Bank reconciled',
  'Unposted journals',
  'AR sub-ledger ties to GL',
  'AP sub-ledger ties to GL',
  'VAT reviewed',
  'Trial balance balanced',
];

const CHECK_FALLBACK_HREFS: string[] = [
  '/accounting/bank-transactions',
  '/accounting/journal-entries',
  '/accounting/customer-invoices',
  '/accounting/supplier-invoices',
  '/accounting/reports/vat-return',
  '/accounting/trial-balance',
];

// ── Aggregation ──────────────────────────────────────────────────────────────

function aggregateStatus(items: ChecklistItem[]): ChecklistItemStatus {
  if (items.some(i => i.status === 'fail')) return 'fail';
  if (items.some(i => i.status === 'warn')) return 'warn';
  return 'pass';
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function getCloseReadiness(
  companyId: string,
  periodId: string,
): Promise<CloseReadiness | null> {
  const period = await getFiscalPeriodById(companyId, periodId);
  if (!period) return null;

  const { startDate, endDate, periodName } = period;

  log.info('Running close-readiness checks', { companyId, periodId }, 'accounting');

  // Promise.allSettled: one broken check emits warn instead of blankings the panel.
  const results = await Promise.allSettled([
    bankReconciledCheck(companyId, { startDate, endDate }),
    unpostedJournalsCheck(companyId, { id: periodId }),
    arSubLedgerCheck(companyId, { endDate }),
    apSubLedgerCheck(companyId, { endDate }),
    vatReviewedCheck(companyId, { startDate, endDate }),
    tbBalancedCheck(companyId, { id: periodId }),
  ]);

  const items: ChecklistItem[] = results.map((r, idx) => {
    if (r.status === 'fulfilled') return r.value;
    log.error('close-readiness check failed', { error: r.reason, checkIndex: idx }, 'accounting');
    return {
      key: CHECK_KEYS[idx]!,
      label: CHECK_LABELS[idx]!,
      status: 'warn' as ChecklistItemStatus,
      reason: 'Could not compute — check the relevant module.',
      fixHref: CHECK_FALLBACK_HREFS[idx]!,
    };
  });

  return {
    periodId,
    periodLabel: periodName,
    items,
    overallStatus: aggregateStatus(items),
  };
}
