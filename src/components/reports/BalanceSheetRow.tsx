/**
 * BalanceSheetRow
 * One account row in the Balance Sheet report.
 * Chevron-toggle and account-name link are siblings (never nested) — no
 * invalid HTML, no stopPropagation needed.
 */

import Link from 'next/link';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { AccountDrillDown } from '@/components/accounting/AccountDrillDown';
import { formatCurrency } from '@/utils/formatters';

export interface BsAccount {
  accountCode: string;
  accountName: string;
  balance: number;
  priorBalance?: number;
  variance?: number;
}

interface Props {
  account: BsAccount;
  isExpanded: boolean;
  onToggle: (code: string) => void;
  onEvidenceClick: (accountId: string, accountName: string) => void;
  showComparative: boolean;
  drillDownStart: string;
  drillDownEnd: string;
}

export function BalanceSheetRow({
  account: a,
  isExpanded,
  onToggle,
  onEvidenceClick,
  showComparative,
  drillDownStart,
  drillDownEnd,
}: Props) {
  const detailHref =
    `/accounting/reports/account-detail/${encodeURIComponent(a.accountCode)}` +
    `?from=${encodeURIComponent(drillDownStart)}&to=${encodeURIComponent(drillDownEnd)}&source=bs`;

  return (
    <div>
      <div className="w-full px-6 py-2 flex items-center justify-between text-sm hover:bg-[var(--ff-bg-tertiary)] gap-2">
        {/* Chevron toggle — standalone interactive element */}
        <button
          type="button"
          onClick={() => onToggle(a.accountCode)}
          aria-label={isExpanded ? 'Collapse' : 'Expand'}
          className="p-0.5 text-[var(--ff-text-tertiary)] shrink-0"
        >
          {isExpanded
            ? <ChevronDown className="h-3 w-3" />
            : <ChevronRight className="h-3 w-3" />}
        </button>

        {/* Account code */}
        <span className="font-mono text-xs text-[var(--ff-text-secondary)] w-14 shrink-0">
          {a.accountCode}
        </span>

        {/* Account name link — sibling of chevron, never nested inside it */}
        <Link
          href={detailHref}
          className="flex-1 text-[var(--ff-text-secondary)] hover:underline hover:text-indigo-400 transition-colors truncate"
        >
          {a.accountName}
        </Link>

        {/* Amount / comparative columns */}
        {showComparative && a.priorBalance !== undefined ? (
          <span className="flex items-center gap-3 shrink-0">
            <span className="font-mono text-[var(--ff-text-tertiary)] text-xs w-24 text-right">
              {formatCurrency(a.priorBalance)}
            </span>
            <button
              type="button"
              onClick={() => onEvidenceClick(a.accountCode, a.accountName)}
              className="font-mono text-[var(--ff-text-primary)] w-24 text-right hover:text-indigo-400"
            >
              {formatCurrency(a.balance)}
            </button>
            <span
              className={`font-mono text-xs w-20 text-right ${
                (a.variance ?? 0) >= 0 ? 'text-teal-400' : 'text-red-400'
              }`}
            >
              {(a.variance ?? 0) >= 0 ? '+' : ''}{formatCurrency(a.variance ?? 0)}
            </span>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => onEvidenceClick(a.accountCode, a.accountName)}
            className="font-mono text-[var(--ff-text-primary)] hover:text-indigo-400 shrink-0"
          >
            {formatCurrency(a.balance)}
          </button>
        )}
      </div>

      {isExpanded && (
        <AccountDrillDown
          accountCode={a.accountCode}
          periodStart={drillDownStart}
          periodEnd={drillDownEnd}
        />
      )}
    </div>
  );
}
