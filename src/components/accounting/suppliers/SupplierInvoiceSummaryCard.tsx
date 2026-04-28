/**
 * Sticky summary card on the supplier-invoice create page —
 * subtotal / VAT / total + the Create button.
 */

import { Loader2, Receipt } from 'lucide-react';
import { formatCurrency } from '@/utils/formatters';

const card = 'bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm';

export interface SupplierInvoiceSummaryCardProps {
  subtotal: number;
  totalTax: number;
  total: number;
  taxRate: number;
  isSubmitting: boolean;
}

export function SupplierInvoiceSummaryCard({
  subtotal, totalTax, total, taxRate, isSubmitting,
}: SupplierInvoiceSummaryCardProps) {
  return (
    <div className="w-72 shrink-0">
      <div className="sticky top-6">
        <div className={`${card} p-5`}>
          <div className="flex items-center gap-2 mb-5">
            <Receipt className="w-4 h-4 text-amber-500" />
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Summary</h3>
          </div>
          <div className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-slate-500 dark:text-slate-400">Subtotal</span>
              <span className="font-mono text-slate-900 dark:text-slate-100">{formatCurrency(subtotal)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-500 dark:text-slate-400">VAT ({taxRate}%)</span>
              <span className="font-mono text-slate-900 dark:text-slate-100">{formatCurrency(totalTax)}</span>
            </div>
            <div className="h-px bg-slate-100 dark:bg-slate-800" />
            <div className="flex justify-between">
              <span className="text-sm font-semibold text-slate-900 dark:text-white">Total</span>
              <span className="font-mono font-bold text-lg text-amber-500">{formatCurrency(total)}</span>
            </div>
          </div>
          <button type="submit" disabled={isSubmitting} className="w-full mt-6 py-3 bg-teal-600 hover:bg-teal-700 text-white font-semibold rounded-xl transition-colors disabled:opacity-50 flex items-center justify-center gap-2 text-sm">
            {isSubmitting ? <><Loader2 className="h-4 w-4 animate-spin" />Creating…</> : <><Receipt className="h-4 w-4" />Create Invoice</>}
          </button>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400 text-center px-2 mt-3">Invoice will be saved as a draft. Approve it from the invoice detail page.</p>
      </div>
    </div>
  );
}
