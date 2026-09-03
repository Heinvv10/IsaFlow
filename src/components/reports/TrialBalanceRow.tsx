/**
 * TrialBalanceRow
 * One account row in the Trial Balance table, plus its expanded drill-down panel.
 * Chevron toggle and account-name link are in separate td cells — no nesting.
 */

import React from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { AccountDrillDown } from '@/components/accounting/AccountDrillDown';
import { useTableDensity } from '@/contexts/TableDensityContext';

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const TYPE_PILL: Record<string, string> = {
  asset:     'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
  liability: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  equity:    'bg-purple-100 text-purple-700 dark:bg-purple-500/15 dark:text-purple-300',
  revenue:   'bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300',
  expense:   'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
};
const NEUTRAL_PILL = 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300';

export interface TBRowData {
  accountCode: string;
  accountName: string;
  accountType: string;
  /** Closing balance for the period — cumulative for balance-sheet accounts. */
  debitBalance: number;
  creditBalance: number;
  priorDebitBalance?: number;
  priorCreditBalance?: number;
  /** Balance carried into the period. */
  openingDebit?: number;
  openingCredit?: number;
  /** Debit / credit turnover within the period. */
  periodDebit?: number;
  periodCredit?: number;
  /** Computed line with no journal behind it — retained earnings brought forward. */
  derived?: boolean;
}

interface Props {
  row: TBRowData;
  isExpanded: boolean;
  onToggle: (code: string) => void;
  onEvidence: (accountId: string, accountName: string) => void;
  showComparative: boolean;
  showMovement: boolean;
  drillDownStart: string;
  drillDownEnd: string;
  colSpan: number;
}

export function TrialBalanceRow({
  row: r, isExpanded, onToggle, onEvidence,
  showComparative, showMovement, drillDownStart, drillDownEnd, colSpan,
}: Props) {
  const { rowClass } = useTableDensity();

  const detailHref =
    `/accounting/reports/account-detail/${encodeURIComponent(r.accountCode)}` +
    `?from=${encodeURIComponent(drillDownStart)}&to=${encodeURIComponent(drillDownEnd)}&source=tb`;

  // A derived row has no journals behind it: expanding it or drilling into it
  // would show an empty ledger and imply the figure was posted. Neither is offered.
  const derived = r.derived === true;

  return (
    <React.Fragment>
      <tr
        onClick={derived ? undefined : () => onToggle(r.accountCode)}
        className={`border-b border-[var(--ff-border-light)] ${derived
          ? 'bg-[var(--ff-bg-tertiary)]/40'
          : 'hover:bg-[var(--ff-bg-primary)]/50 cursor-pointer'}`}
      >
        <td className={`${rowClass} font-mono text-[var(--ff-text-tertiary)]`}>
          <span className="flex items-center gap-1">
            {derived ? <span className="w-3" aria-hidden="true" /> : isExpanded
              ? <ChevronDown className="h-3 w-3" />
              : <ChevronRight className="h-3 w-3" />}
            {r.accountCode}
          </span>
        </td>
        <td className={`${rowClass} text-[var(--ff-text-primary)]`}>
          {derived ? (
            <span className="flex items-center gap-2">
              <span
                className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"
                title="Computed from the ledger, not posted to any account"
              >
                Derived
              </span>
              <span className="text-[var(--ff-text-secondary)]">{r.accountName}</span>
            </span>
          ) : (
            <Link
              href={detailHref}
              onClick={e => e.stopPropagation()}
              className="hover:underline hover:text-indigo-400 transition-colors"
            >
              {r.accountName}
            </Link>
          )}
        </td>
        <td className={rowClass}>
          <span className={`px-2 py-0.5 rounded text-xs font-medium uppercase tracking-wide ${TYPE_PILL[r.accountType.toLowerCase()] ?? NEUTRAL_PILL}`}>
            {r.accountType}
          </span>
        </td>
        {showMovement && (
          <>
            <td className={`${rowClass} text-right text-[var(--ff-text-secondary)] text-xs`}>
              {(r.openingDebit ?? 0) > 0 ? fmt(r.openingDebit ?? 0) : '—'}
            </td>
            <td className={`${rowClass} text-right text-[var(--ff-text-secondary)] text-xs`}>
              {(r.openingCredit ?? 0) > 0 ? fmt(r.openingCredit ?? 0) : '—'}
            </td>
            <td className={`${rowClass} text-right text-[var(--ff-text-secondary)] text-xs`}>
              {(r.periodDebit ?? 0) > 0 ? fmt(r.periodDebit ?? 0) : '—'}
            </td>
            <td className={`${rowClass} text-right text-[var(--ff-text-secondary)] text-xs`}>
              {(r.periodCredit ?? 0) > 0 ? fmt(r.periodCredit ?? 0) : '—'}
            </td>
          </>
        )}
        <td className={`${rowClass} text-right text-[var(--ff-text-primary)]`}>
          {r.debitBalance > 0 ? fmt(r.debitBalance) : '—'}
        </td>
        <td className={`${rowClass} text-right text-[var(--ff-text-primary)]`}>
          {r.creditBalance > 0 ? fmt(r.creditBalance) : '—'}
        </td>
        {showComparative && (
          <>
            <td className={`${rowClass} text-right text-[var(--ff-text-tertiary)] text-xs`}>
              {(r.priorDebitBalance ?? 0) > 0 ? fmt(r.priorDebitBalance ?? 0) : '—'}
            </td>
            <td className={`${rowClass} text-right text-[var(--ff-text-tertiary)] text-xs`}>
              {(r.priorCreditBalance ?? 0) > 0 ? fmt(r.priorCreditBalance ?? 0) : '—'}
            </td>
          </>
        )}
        <td className={`${rowClass} text-center`} onClick={e => e.stopPropagation()}>
          {derived ? (
            <span className="text-xs text-[var(--ff-text-tertiary)]">—</span>
          ) : (
            <button
              onClick={() => onEvidence(r.accountCode, r.accountName)}
              className="px-2 py-1 rounded text-xs bg-indigo-500/15 text-indigo-400 hover:bg-indigo-500/25 whitespace-nowrap"
            >
              Evidence
            </button>
          )}
        </td>
      </tr>
      {isExpanded && !derived && (
        <AccountDrillDown
          accountCode={r.accountCode}
          periodStart={drillDownStart}
          periodEnd={drillDownEnd}
          asTableRow
          colSpan={colSpan}
        />
      )}
    </React.Fragment>
  );
}
