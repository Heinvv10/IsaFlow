/**
 * NoBankAccountWarning — Dashboard inline warning banner.
 *
 * Shown when the tenant has a non-zero cash position reported in the KPI
 * cards but no GL account with account_subtype = 'bank' exists.
 *
 * Sits adjacent to the Cash Position KPI tile; never inside WorkbenchSection
 * (that section is for exception cards only).
 */

import Link from 'next/link';
import { AlertTriangle, ArrowRight } from 'lucide-react';

export function NoBankAccountWarning() {
  return (
    <div
      role="alert"
      className="flex items-center gap-4 p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-500/30 rounded-lg"
    >
      <div className="p-2 rounded-lg bg-amber-100 dark:bg-amber-500/10 shrink-0">
        <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" aria-hidden="true" />
      </div>

      <div className="flex-1 min-w-0">
        <p className="font-semibold text-amber-800 dark:text-amber-300 text-sm">
          Cash position shown but no bank account configured
        </p>
        <p className="text-xs text-amber-800 dark:text-amber-400/70 mt-0.5">
          Reconciliation is unavailable until you add a bank account.
        </p>
      </div>

      <Link
        href="/accounting/bank-accounts"
        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-700 hover:bg-amber-800 dark:bg-amber-600 dark:hover:bg-amber-500 text-white rounded-lg text-xs font-medium transition-colors shrink-0 no-underline"
      >
        Add Bank Account
        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
      </Link>
    </div>
  );
}
