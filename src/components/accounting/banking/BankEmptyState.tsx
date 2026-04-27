/**
 * BankEmptyState — Action-rich empty state for bank pages.
 *
 * Answers the four audit questions:
 *   (a) What is missing — no bank account configured
 *   (b) Why it matters — required for statement imports and reconciliation
 *   (c) Next best action — Add Bank Account (primary), Import Statement (disabled)
 *   (d) What accounting object will be created — GL account, asset type, subtype bank
 */

import Link from 'next/link';
import { Landmark, ArrowRight } from 'lucide-react';

interface Props {
  /** Context determines the secondary copy shown below the buttons. */
  context: 'bank-accounts' | 'bank-transactions';
  /** Callback to open the Add Bank Account modal (bank-accounts page only). */
  onAddBankAccount?: () => void;
}

export function BankEmptyState({ context, onAddBankAccount }: Props) {
  const isTransactionsPage = context === 'bank-transactions';

  return (
    <div className="flex items-start justify-center px-6 py-16">
      <div className="max-w-lg w-full bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-xl p-8 text-center">
        {/* Icon */}
        <div className="mx-auto w-14 h-14 rounded-full bg-teal-500/10 border border-teal-500/30 flex items-center justify-center mb-4">
          <Landmark className="h-7 w-7 text-teal-400" />
        </div>

        {/* Heading — what is missing */}
        <h2 className="text-xl font-semibold text-[var(--ff-text-primary)] mb-2">
          No bank accounts configured
        </h2>

        {/* Why it matters */}
        <p className="text-sm text-[var(--ff-text-secondary)] mb-1">
          Bank accounts are required before statement imports and reconciliation.
        </p>
        <p className="text-xs text-[var(--ff-text-tertiary)] mb-6">
          A bank account in IsaFlow is a GL account with subtype &quot;bank&quot; under your asset accounts.
        </p>

        {/* Action buttons — next best action */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mb-6">
          {isTransactionsPage ? (
            <Link
              href="/accounting/bank-accounts"
              className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-500 text-white rounded-lg text-sm font-medium transition-colors"
            >
              Add Bank Account
              <ArrowRight className="h-4 w-4" />
            </Link>
          ) : (
            <button
              type="button"
              onClick={onAddBankAccount}
              className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-500 text-white rounded-lg text-sm font-medium transition-colors"
            >
              Add Bank Account
              <ArrowRight className="h-4 w-4" />
            </button>
          )}

          {/* Import Statement — disabled until a bank account exists */}
          <div className="relative group">
            <button
              type="button"
              disabled
              className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-tertiary)] rounded-lg text-sm font-medium cursor-not-allowed opacity-60"
              aria-describedby="import-disabled-tooltip"
            >
              Import Statement
            </button>
            <div
              id="import-disabled-tooltip"
              role="tooltip"
              className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-1.5 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-secondary)] whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10"
            >
              Create a bank account first
            </div>
          </div>
        </div>

        {/* What accounting object will be created */}
        <div className="text-left bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] rounded-lg p-4">
          <p className="text-xs font-medium text-[var(--ff-text-secondary)] mb-1">
            What happens when you add a bank account
          </p>
          <p className="text-xs text-[var(--ff-text-tertiary)] leading-relaxed">
            IsaFlow creates a GL account in your chart of accounts under the assets section
            with subtype &quot;bank&quot;. You can then import CSV bank statements and reconcile
            them against your double-entry books.
          </p>
        </div>
      </div>
    </div>
  );
}
