/**
 * Period Close Readiness Service — orchestrator
 *
 * Runs 6 advisory checks to determine whether a fiscal period is ready to
 * close.  Each check runs inside its OWN savepoint, SEQUENTIALLY, so a
 * DB-level error in one check rolls back to that savepoint instead of poisoning
 * the shared request transaction — and one failing check still cannot blank the
 * whole panel (it degrades to a single 'warn' row).
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
import { withSavepoint } from '@/lib/neon';
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

  // getCloseReadiness runs inside startCloseRun's request transaction, which
  // then WRITES (abandonOpenRunsForPeriod / insertCloseRun / insertProposals).
  // A DB-level error in any check (e.g. schema drift) aborts a plain request tx
  // — "current transaction is aborted" — and every later write 500s. Each check
  // therefore runs inside its OWN savepoint: an errored check rolls back to the
  // savepoint (recovering the tx) and degrades to a single 'warn' row while the
  // remaining checks and the caller's writes proceed on a healthy tx.
  //
  // SEQUENTIAL, not Promise.allSettled: savepoints on the single request
  // connection must nest LIFO. Run concurrently and their SAVEPOINT/RELEASE
  // pairs interleave — releasing an earlier savepoint destroys the later ones,
  // so the next RELEASE errors and re-poisons the tx. On one connection the
  // per-check queries already serialize at the wire, so sequencing costs nothing.
  const runners: Array<() => Promise<ChecklistItem>> = [
    () => bankReconciledCheck(companyId, { startDate, endDate }),
    () => unpostedJournalsCheck(companyId, { id: periodId }),
    () => arSubLedgerCheck(companyId, { endDate }),
    () => apSubLedgerCheck(companyId, { endDate }),
    () => vatReviewedCheck(companyId, { startDate, endDate }),
    () => tbBalancedCheck(companyId, { id: periodId }),
  ];

  const items: ChecklistItem[] = [];
  for (let idx = 0; idx < runners.length; idx++) {
    try {
      items.push(await withSavepoint(`close_check_${idx}`, runners[idx]!));
    } catch (err) {
      log.error('close-readiness check failed', { error: err, checkIndex: idx }, 'accounting');
      items.push({
        key: CHECK_KEYS[idx]!,
        label: CHECK_LABELS[idx]!,
        status: 'warn' as ChecklistItemStatus,
        reason: 'Could not compute — check the relevant module.',
        fixHref: CHECK_FALLBACK_HREFS[idx]!,
      });
    }
  }

  return {
    periodId,
    periodLabel: periodName,
    items,
    overallStatus: aggregateStatus(items),
  };
}
