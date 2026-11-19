/**
 * Status tab strip with optional per-status count badges. When the company has an intercompany connection, a trailing
 * "Intercompany" tab leads to the inbox of invoices and credit notes other companies sent it (P2), with the count that needs a person.
 */

import Link from 'next/link';
import {
  SUPPLIER_INVOICE_TABS,
  SUPPLIER_INVOICE_TAB_LABEL,
  type SupplierInvoiceTab,
} from './listTypes';

interface Props {
  /** The selected status tab; null on the intercompany inbox, where none is. */
  active: SupplierInvoiceTab | null;
  counts: Record<string, number>;
  onChange: (t: SupplierInvoiceTab) => void;
  /** Shown when set: how many intercompany messages need a person, and whether this strip is on that page. */
  intercompany?: { count: number; active: boolean } | null;
}

export function StatusTabs({ active, counts, onChange, intercompany }: Props) {
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
            className={`px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors flex items-center gap-1.5 ${selected ? 'bg-brand-600 text-white shadow-sm' : 'text-ink-muted hover:bg-surface-sunken'}`}
          >
            <span>{SUPPLIER_INVOICE_TAB_LABEL[t]}</span>
            {typeof count === 'number' && (
              <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${selected ? 'bg-brand-800 text-white' : 'bg-surface-sunken text-ink-muted'}`}>
                {count}
              </span>
            )}
          </button>
        );
      })}
      {intercompany && (
        <Link
          href="/accounting/supplier-invoices/intercompany"
          aria-current={intercompany.active ? 'page' : undefined}
          data-testid="intercompany-tab"
          className={`px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors flex items-center gap-1.5 ${intercompany.active ? 'bg-brand-600 text-white shadow-sm' : 'text-ink-muted hover:bg-surface-sunken'}`}
        >
          <span>Intercompany</span>
          {intercompany.count > 0 && (
            <span data-testid="intercompany-badge" aria-label={`${intercompany.count} waiting`}
              className={`text-xs tabular-nums px-1.5 py-0.5 rounded ${intercompany.active ? 'bg-brand-800 text-white' : 'bg-amber-500/20 text-amber-700 dark:text-amber-300'}`}>
              {intercompany.count}
            </span>
          )}
        </Link>
      )}
    </div>
  );
}
