/**
 * BankAccountCard — single account tile on the Bank Accounts page.
 */

import Link from 'next/link';
import { ArrowUpRight, ArrowDownRight, Pencil, ExternalLink, Layers } from 'lucide-react';
import { formatCurrency } from '@/utils/formatters';

export interface BankAccountCardData {
  id: string;
  accountCode: string;
  accountName: string;
  description?: string;
  bankAccountNumber?: string | null;
  isActive: boolean;
  groupId?: string | null;
  groupName?: string | null;
  txnCount: number;
  totalDebits: number;
  totalCredits: number;
  balance: number;
  firstDate?: string;
  lastDate?: string;
}

/** Mask account number for display: show last 4 digits only */
function maskAccountNumber(num: string): string {
  if (num.length <= 4) return num;
  return '****' + num.slice(-4);
}

export function BankAccountCard({ acct, onEdit }: { acct: BankAccountCardData; onEdit: (acct: BankAccountCardData) => void }) {
  return (
    <div className="p-5 rounded-xl bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] hover:border-cyan-500/30 transition-colors relative group">
      <button
        onClick={() => onEdit(acct)}
        className="absolute top-3 right-12 p-1.5 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-tertiary)] hover:text-cyan-400 transition-all"
        title="Edit account"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-mono text-[var(--ff-text-tertiary)]">{acct.accountCode}</span>
        <span className={`px-2 py-0.5 rounded-full text-xs ${acct.isActive ? 'bg-teal-500/10 text-teal-400' : 'bg-red-500/10 text-red-400'}`}>
          {acct.isActive ? 'Active' : 'Inactive'}
        </span>
      </div>
      <h3 className="text-lg font-semibold text-[var(--ff-text-primary)]">{acct.accountName}</h3>
      {acct.groupName && (
        <p className="flex items-center gap-1 text-xs text-[var(--ff-text-tertiary)] mt-0.5">
          <Layers className="h-3 w-3" /> {acct.groupName}
        </p>
      )}
      {acct.bankAccountNumber && (
        <p className="text-xs font-mono text-[var(--ff-text-tertiary)] mt-0.5">
          Acc: {maskAccountNumber(acct.bankAccountNumber)}
        </p>
      )}
      {acct.description && (
        <p className="text-sm text-[var(--ff-text-secondary)] mt-1">{acct.description}</p>
      )}

      <div className="mt-4 pt-3 border-t border-[var(--ff-border-light)]">
        <p className="text-sm text-[var(--ff-text-secondary)]">Net Balance</p>
        <p className={`text-2xl font-bold ${acct.balance >= 0 ? 'text-teal-400' : 'text-red-400'}`}>
          {formatCurrency(acct.balance)}
        </p>
      </div>

      <div className="mt-3 flex gap-4 text-sm">
        <div className="flex items-center gap-1 text-teal-400">
          <ArrowDownRight className="h-3.5 w-3.5" />
          <span>{formatCurrency(acct.totalCredits)}</span>
        </div>
        <div className="flex items-center gap-1 text-red-400">
          <ArrowUpRight className="h-3.5 w-3.5" />
          <span>{formatCurrency(acct.totalDebits)}</span>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between text-xs text-[var(--ff-text-tertiary)]">
        <span>{acct.txnCount.toLocaleString()} transactions</span>
        {acct.firstDate && acct.lastDate && (
          <span>{acct.firstDate} &rarr; {acct.lastDate}</span>
        )}
      </div>

      <div className="mt-3 pt-3 border-t border-[var(--ff-border-light)]">
        <Link
          href={`/accounting/bank-transactions?account_id=${acct.id}`}
          className="flex items-center gap-1.5 text-xs font-medium text-cyan-400 hover:text-cyan-300 transition-colors"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          View Transactions
        </Link>
      </div>
    </div>
  );
}
