/**
 * The quote form's VAT controls and totals: "Amounts are" and "VAT rate %" as on the invoice form
 * (InvoiceHeaderFields), or, for a company known not to be VAT registered, a note and the total only.
 */
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { formatMoney as fmt } from '@/lib/money/formatMoney';
import { effectiveTaxRate, TAX_MODE_OPTIONS, type TaxMode } from '@/components/accounting/customer-invoices/taxMode';
import type { InvoiceTotals } from '@/modules/accounting/services/ar/invoiceLineAmount';
import type { VatRegistration } from '@/hooks/vatRegistrationState';

interface Props {
  registration: VatRegistration;
  mode: TaxMode;
  rate: number;
  totals: InvoiceTotals;
  onModeChange: (mode: TaxMode) => void;
  onRateChange: (rate: number) => void;
}

const muted = 'text-slate-500 dark:text-slate-400';
const figure = 'tabular-nums text-slate-700 dark:text-slate-200';

export function QuoteVatFields({ registration, mode, rate, totals, onModeChange, onRateChange }: Props) {
  const nonVendor = registration.known && !registration.isRegistered;
  const shownRate = effectiveTaxRate(mode, rate);
  return (
    <div className="mt-3 space-y-3">
      {nonVendor ? (
        <p className={`text-xs ${muted}`}>This company is not VAT registered, so no VAT is added.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Select label="Amounts are" options={TAX_MODE_OPTIONS} value={mode} onChange={(v) => onModeChange((v ?? 'exclusive') as TaxMode)} />
          <Input label="VAT rate %" type="number" name="taxRate" min={0} max={100} value={shownRate} disabled={mode === 'none'}
            onChange={(e) => onRateChange(Number(e.target.value))} />
        </div>
      )}
      {totals.subtotal > 0 && (
        <div className="flex justify-end gap-4 text-sm px-1">
          {!nonVendor && <span className={muted}>Subtotal <span className={figure}>{fmt(totals.subtotal)}</span></span>}
          {!nonVendor && mode !== 'none' && <span className={muted}>VAT {shownRate}% <span className={figure}>{fmt(totals.tax)}</span></span>}
          <span className="font-bold text-amber-500 tabular-nums">{fmt(totals.total)}</span>
        </div>
      )}
    </div>
  );
}
