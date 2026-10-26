import { DateField } from '@/components/ui';
/** Section 3 of the new-asset form: purchase date, cost, salvage value and useful life. */
export const inp = 'w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 transition-colors';
export const lbl = 'block text-xs font-semibold text-ink-muted uppercase tracking-wider mb-1.5';
export const card = 'bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm';

export interface AssetFinancialForm {
  purchaseDate: string;
  cost: string;
  salvageValue: string;
  usefulLifeYears: string;
}

export function AssetFinancialFields({ form, update, onDateChange, dateError }: {
  form: AssetFinancialForm;
  update: (field: string, value: string) => void;
  onDateChange: (iso: string | null, reason: string | null) => void;
  dateError?: string;
}) {
  return (
    <div className={`${card} p-5`}>
      <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
        <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">3</span>
        Financial Details
      </h3>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <DateField
            label="Purchase Date"
            name="purchaseDate"
            required
            error={dateError || undefined}
            value={form.purchaseDate || null}
            onChange={(iso, v) => onDateChange(iso, v.valid ? null : v.reason)}
          />
        </div>
        <div>
          <label htmlFor="asset-cost" className={lbl}>Cost (Purchase Price) *</label>
          <input id="asset-cost" type="number" name="cost" required step="0.01" min="0.01" value={form.cost}
            onChange={e => update('cost', e.target.value)}
            placeholder="25000.00" className={inp} />
        </div>
        <div>
          <label htmlFor="asset-salvageValue" className={lbl}>Salvage (Residual) Value</label>
          <input id="asset-salvageValue" type="number" name="salvageValue" step="0.01" min="0" value={form.salvageValue}
            onChange={e => update('salvageValue', e.target.value)}
            placeholder="0.00" className={inp} />
        </div>
        <div>
          <label htmlFor="asset-usefulLifeYears" className={lbl}>Useful Life (years) *</label>
          <input id="asset-usefulLifeYears" type="number" name="usefulLifeYears" required step="0.5" min="0.5" value={form.usefulLifeYears}
            onChange={e => update('usefulLifeYears', e.target.value)} className={inp} />
        </div>
      </div>
    </div>
  );
}
