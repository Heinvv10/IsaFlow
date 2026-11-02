/**
 * InvoiceSummaryCard — the totals card on the new and edit invoice pages. Stacks under the form below `lg`;
 * the page puts its action buttons in `children`.
 */
import type { ReactNode } from 'react';
import { Receipt } from 'lucide-react';
import { formatCurrencyAmount } from '@/modules/accounting/services/core/multiCurrencyService';

interface Props {
  subtotal: number;
  tax: number;
  total: number;
  taxRate: number;
  currencyCode: string;
  /** Foreign-currency invoices only: the ZAR preview and the rate it used. */
  fx?: { zarTotal: number; rate: number };
  /** Inclusive mode only: the gross the shown prices add up to. Shown beside `total` whenever the two differ; the stored total is the invoice (taxMode.ts). */
  typedTotal?: number;
  children: ReactNode;
}

export function InvoiceSummaryCard({ subtotal, tax, total, taxRate, currencyCode, fx, typedTotal, children }: Props) {
  return (
    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm p-5">
      <div className="flex items-center gap-2 mb-5">
        <Receipt className="w-4 h-4 text-amber-500" />
        <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Invoice Summary</h3>
      </div>
      <div className="space-y-3">
        <div className="flex justify-between text-sm">
          <span className="text-ink-muted">Subtotal</span>
          <span className="tabular-nums text-slate-900 dark:text-slate-100">{formatCurrencyAmount(subtotal, currencyCode)}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-ink-muted">VAT ({taxRate}%)</span>
          <span className="tabular-nums text-slate-900 dark:text-slate-100">{formatCurrencyAmount(tax, currencyCode)}</span>
        </div>
        <div className="h-px bg-slate-100 dark:bg-slate-800" />
        <div className="flex justify-between">
          <span className="text-sm font-semibold text-slate-900 dark:text-white">Total</span>
          <span className="tabular-nums font-bold text-lg text-amber-500">{formatCurrencyAmount(total, currencyCode)}</span>
        </div>
        {/* Always mounted: a status region announces a change only if it was in the page before the change. */}
        <div role="status">
          {typedTotal !== undefined && typedTotal !== total && (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              These prices come to {formatCurrencyAmount(typedTotal, currencyCode)} incl. VAT; the invoice total is {formatCurrencyAmount(total, currencyCode)}.
            </p>
          )}
        </div>
        {fx && (
          <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
            <p className="text-xs text-ink-muted flex justify-between">
              <span>ZAR equivalent</span>
              <span className="tabular-nums text-amber-600 dark:text-amber-400 font-semibold">{formatCurrencyAmount(fx.zarTotal, 'ZAR')}</span>
            </p>
            <p className="text-xs text-ink-muted mt-0.5">@ {fx.rate} {currencyCode}/ZAR</p>
          </div>
        )}
      </div>
      {children}
    </div>
  );
}
