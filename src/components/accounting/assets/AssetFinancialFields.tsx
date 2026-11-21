import { DateField, type DateFieldCode, type FieldValidity } from '@/components/ui';
import { AmountInput } from '@/components/ui/AmountInput';
/** Section 3 of the new-asset form: purchase date, cost, salvage value and useful life. */
export const inp = 'w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 transition-colors';
export const lbl = 'block text-sm font-medium text-ink-muted mb-1.5';
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
  onDateChange: (iso: string | null, validity: FieldValidity<DateFieldCode>) => void;
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
            onChange={onDateChange}
          />
        </div>
        <div>
          <label htmlFor="asset-cost" className={lbl}>Cost (purchase price) *</label>
          <AmountInput min={0.01} id="asset-cost" name="cost" required value={form.cost}
            onValueChange={(_n, t) => update('cost', t)}
            placeholder="25000.00" className={inp} />
        </div>
        <div>
          <label htmlFor="asset-salvageValue" className={lbl}>Salvage (Residual) Value</label>
          <AmountInput min={0} id="asset-salvageValue" name="salvageValue" value={form.salvageValue}
            onValueChange={(_n, t) => update('salvageValue', t)}
            placeholder="0.00" className={inp} />
        </div>
        <div>
          <label htmlFor="asset-usefulLifeYears" className={lbl}>Useful life (years) *</label>
          <input id="asset-usefulLifeYears" type="number" name="usefulLifeYears" required step="0.5" min="0.5" value={form.usefulLifeYears}
            onChange={e => update('usefulLifeYears', e.target.value)} className={inp} />
        </div>
      </div>
    </div>
  );
}
