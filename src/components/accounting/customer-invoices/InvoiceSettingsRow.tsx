/**
 * InvoiceSettingsRow — the compact row above the line grid on the new and edit invoice pages: "Amounts are", the
 * currency and (foreign currency only) the exchange rate. VAT is per line (formVat), so there is no rate here. A company
 * not registered for VAT is offered no choice: the row says the invoice carries no VAT. The page owns the form; a
 * refused "Amounts are" switch (useTaxModeSwitch) is said by the selector, announced and scrolled into view.
 */
import { useEffect, useId, useRef } from 'react';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import type { InvoiceHeaderForm } from './invoiceHeaderForm';
import type { InvoiceCurrency } from './InvoiceHeaderFields';
import { TAX_MODE_OPTIONS, type TaxMode } from './taxMode';

interface Props {
  form: Pick<InvoiceHeaderForm, 'currencyCode' | 'exchangeRate'>;
  currencies: InvoiceCurrency[];
  onChange: (patch: Partial<InvoiceHeaderForm>) => void;
  /** False for a company not registered for VAT: no "Amounts are" choice. */
  registered: boolean;
  taxMode: TaxMode;
  /** The options offered (taxModeSwitch.taxModesFor). */
  taxModes?: typeof TAX_MODE_OPTIONS;
  /** Why the last "Amounts are" change was refused (taxModeSwitch); null when none. */
  taxModeProblem?: string | null;
  onTaxModeChange: (mode: TaxMode) => void;
}

const lbl = 'mb-1 text-xs font-medium text-slate-600 dark:text-slate-400';

export function InvoiceSettingsRow({ form, currencies, onChange, registered, taxMode, taxModes = TAX_MODE_OPTIONS, taxModeProblem, onTaxModeChange }: Props) {
  const problemId = useId();
  const problem = useRef<HTMLParagraphElement>(null);
  // A refused switch is said where the user is looking: scrolled into view.
  useEffect(() => { if (taxModeProblem) problem.current?.scrollIntoView?.({ block: 'nearest' }); }, [taxModeProblem]);
  const isFx = form.currencyCode !== 'ZAR';
  const currencyOptions = [{ value: 'ZAR', label: 'ZAR — South African Rand' }, ...currencies.filter((c) => c.code !== 'ZAR').map((c) => ({ value: c.code, label: `${c.code} — ${c.name}` }))];
  return (
    <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-800">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        {registered ? (
          <div className="w-44">
            <Select label="Amounts are" labelClassName={lbl} size="sm" options={taxModes} value={taxMode}
              onChange={(v) => onTaxModeChange((v ?? 'exclusive') as TaxMode)} describedBy={taxModeProblem ? problemId : undefined} />
          </div>
        ) : (
          <p className="text-xs text-slate-600 dark:text-slate-400 pb-1.5">No VAT: this company is not registered for VAT.</p>
        )}
        <div className="w-64">
          <Select label="Currency" labelClassName={lbl} size="sm" options={currencyOptions} value={form.currencyCode} valueOption={{ value: form.currencyCode, label: form.currencyCode }}
            onChange={(v) => onChange({ currencyCode: v ?? 'ZAR', exchangeRate: (v ?? 'ZAR') === 'ZAR' ? 1 : form.exchangeRate })} />
        </div>
        {isFx && (
          <div className="w-48">
            <Input label={`Exchange rate (${form.currencyCode} → ZAR)`} size="sm" type="number" name="exchangeRate" min={0.000001} step={0.000001}
              value={form.exchangeRate} placeholder="e.g. 18.5" onChange={(e) => onChange({ exchangeRate: Number(e.target.value) })} />
          </div>
        )}
      </div>
      {taxModeProblem && <p id={problemId} ref={problem} role="alert" className="mt-2 text-xs text-red-700 dark:text-red-400">{taxModeProblem}</p>}
    </div>
  );
}
