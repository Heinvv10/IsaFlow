/**
 * Status tab strip with optional per-status count badges.
 */

import {
  SUPPLIER_INVOICE_TABS,
  SUPPLIER_INVOICE_TAB_LABEL,
  type SupplierInvoiceTab,
} from './listTypes';

interface Props {
  active: SupplierInvoiceTab;
  counts: Record<string, number>;
  onChange: (t: SupplierInvoiceTab) => void;
}

export function StatusTabs({ active, counts, onChange }: Props) {
  return (
    <div className="flex gap-1 p-1 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-x-auto">
      {SUPPLIER_INVOICE_TABS.map((t) => {
        const count = counts[t];
        const selected = active === t;
        return (
          <button
            key={t}
            type="button"
            onClick={() => onChange(t)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors flex items-center gap-1.5 ${selected ? 'bg-amber-500 text-white shadow-sm' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
          >
            <span>{SUPPLIER_INVOICE_TAB_LABEL[t]}</span>
            {typeof count === 'number' && (
              <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${selected ? 'bg-white/25 text-white' : 'bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400'}`}>
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
