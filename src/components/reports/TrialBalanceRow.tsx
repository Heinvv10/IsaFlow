/**
 * TrialBalanceRow
 * One account row in the Trial Balance table, plus its expanded drill-down panel.
 * Chevron toggle and account-name link are in separate td cells — no nesting.
 */

import React from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { AccountDrillDown } from '@/components/accounting/AccountDrillDown';

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
  debitBalance: number;
  creditBalance: number;
  priorDebitBalance?: number;
  priorCreditBalance?: number;
}

interface Props {
  row: TBRowData;
  isExpanded: boolean;
  onToggle: (code: string) => void;
  onEvidence: (accountId: string, accountName: string) => void;
  showComparative: boolean;
  drillDownStart: string;
  drillDownEnd: string;
  colSpan: number;
}

export function TrialBalanceRow({
  row: r, isExpanded, onToggle, onEvidence,
  showComparative, drillDownStart, drillDownEnd, colSpan,
}: Props) {
  const detailHref =
    `/accounting/reports/account-detail/${encodeURIComponent(r.accountCode)}` +
    `?from=${encodeURIComponent(drillDownStart)}&to=${encodeURIComponent(drillDownEnd)}&source=tb`;

  return (
    <React.Fragment>
      <tr
        onClick={() => onToggle(r.accountCode)}
        className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50 cursor-pointer"
      >
        <td className="px-4 py-3 font-mono text-[var(--ff-text-tertiary)]">
          <span className="flex items-center gap-1">
            {isExpanded
              ? <ChevronDown className="h-3 w-3" />
              : <ChevronRight className="h-3 w-3" />}
            {r.accountCode}
          </span>
        </td>
        <td className="px-4 py-3 text-[var(--ff-text-primary)]">
          <Link
            href={detailHref}
            onClick={e => e.stopPropagation()}
            className="hover:underline hover:text-indigo-400 transition-colors"
          >
            {r.accountName}
          </Link>
        </td>
        <td className="px-4 py-3">
          <span className={`px-2 py-0.5 rounded text-xs font-medium uppercase tracking-wide ${TYPE_PILL[r.accountType.toLowerCase()] ?? NEUTRAL_PILL}`}>
            {r.accountType}
          </span>
        </td>
        <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">
          {r.debitBalance > 0 ? fmt(r.debitBalance) : '—'}
        </td>
        <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">
          {r.creditBalance > 0 ? fmt(r.creditBalance) : '—'}
        </td>
        {showComparative && (
          <>
            <td className="px-4 py-3 text-right text-[var(--ff-text-tertiary)] text-xs">
              {(r.priorDebitBalance ?? 0) > 0 ? fmt(r.priorDebitBalance ?? 0) : '—'}
            </td>
            <td className="px-4 py-3 text-right text-[var(--ff-text-tertiary)] text-xs">
              {(r.priorCreditBalance ?? 0) > 0 ? fmt(r.priorCreditBalance ?? 0) : '—'}
            </td>
          </>
        )}
        <td className="px-4 py-3 text-center" onClick={e => e.stopPropagation()}>
          <button
            onClick={() => onEvidence(r.accountCode, r.accountName)}
            className="px-2 py-1 rounded text-xs bg-indigo-500/15 text-indigo-400 hover:bg-indigo-500/25 whitespace-nowrap"
          >
            Evidence
          </button>
        </td>
      </tr>
      {isExpanded && (
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
