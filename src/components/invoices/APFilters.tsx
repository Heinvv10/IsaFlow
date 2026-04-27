/**
 * APFilters — accountant signal filter chip strip for the AP (supplier invoice) list.
 *
 * Chips (multi-select, persist in URL via useSupplierInvoiceListState):
 *   - Missing document  — source_document_id IS NULL
 *   - Possible duplicate — same supplier + same invoice_number in the same company
 *   - Due this week     — due_date <= today + 7 days, not paid or cancelled
 *   - Pay run ready     — approved/partially_paid, balance > 0, due within 14 days
 *
 * Each chip delegates state management upwards via onToggle(chip) so this
 * component stays purely presentational and testable.
 */

import { Paperclip, Copy, Calendar, CreditCard } from 'lucide-react';
import type { APSignalChip, SupplierInvoiceListFilters } from '@/components/accounting/supplier-invoices/listTypes';
import { AP_SIGNAL_CHIP_LABELS } from '@/components/accounting/supplier-invoices/listTypes';

interface Chip {
  id: APSignalChip;
  icon: React.ElementType;
  activeClasses: string;
  inactiveClasses: string;
}

const CHIPS: Chip[] = [
  {
    id: 'missingDocument',
    icon: Paperclip,
    activeClasses: 'bg-slate-500/20 text-slate-200 border-slate-400/50',
    inactiveClasses:
      'bg-slate-50 dark:bg-slate-800/50 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700'
      + ' hover:border-slate-400 dark:hover:border-slate-500 hover:text-slate-700 dark:hover:text-slate-200',
  },
  {
    id: 'possibleDuplicate',
    icon: Copy,
    activeClasses: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/50',
    inactiveClasses:
      'bg-slate-50 dark:bg-slate-800/50 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700'
      + ' hover:border-yellow-400/60 dark:hover:border-yellow-500/40 hover:text-yellow-600 dark:hover:text-yellow-300',
  },
  {
    id: 'dueThisWeek',
    icon: Calendar,
    activeClasses: 'bg-amber-500/20 text-amber-300 border-amber-500/50',
    inactiveClasses:
      'bg-slate-50 dark:bg-slate-800/50 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700'
      + ' hover:border-amber-400/60 dark:hover:border-amber-500/40 hover:text-amber-600 dark:hover:text-amber-300',
  },
  {
    id: 'payRunReady',
    icon: CreditCard,
    activeClasses: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50',
    inactiveClasses:
      'bg-slate-50 dark:bg-slate-800/50 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700'
      + ' hover:border-emerald-400/60 dark:hover:border-emerald-500/40 hover:text-emerald-600 dark:hover:text-emerald-300',
  },
];

interface APFiltersProps {
  filters: Pick<SupplierInvoiceListFilters, APSignalChip>;
  onToggle: (chip: APSignalChip) => void;
  onClear?: () => void;
}

export function APFilters({ filters, onToggle, onClear }: APFiltersProps) {
  const anyActive = CHIPS.some((c) => filters[c.id]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 tracking-wide uppercase" id="ap-signal-filters-label">
        Signals
      </span>
      <div role="group" aria-labelledby="ap-signal-filters-label" className="flex flex-wrap items-center gap-2">
      {CHIPS.map((chip) => {
        const Icon = chip.icon;
        const active = filters[chip.id];
        return (
          <button
            key={chip.id}
            type="button"
            onClick={() => onToggle(chip.id)}
            aria-pressed={active}
            className={[
              'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium',
              'border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50',
              active ? chip.activeClasses : chip.inactiveClasses,
            ].join(' ')}
          >
            <Icon className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
            {AP_SIGNAL_CHIP_LABELS[chip.id]}
          </button>
        );
      })}
      {anyActive && onClear && (
        <button
          type="button"
          onClick={onClear}
          className="text-xs text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 underline ml-1 transition-colors"
        >
          Clear signals
        </button>
      )}
      </div>
    </div>
  );
}
