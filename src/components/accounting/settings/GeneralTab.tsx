import { useEffect } from 'react';
import { Lock } from 'lucide-react';
import { DateField, Select } from '@/components/ui';
import { Company, Toggle, INPUT_CLS, LABEL_CLS, SECTION_CLS } from './settingsTypes';
import { FinancialYearStartField } from './FinancialYearStartField';
import { YearEndChangeEntry } from './YearEndChangeEntry';

const CURRENCIES = [
  { value: 'ZAR', label: 'ZAR - South African Rand' },
  { value: 'USD', label: 'USD - US Dollar' },
  { value: 'EUR', label: 'EUR - Euro' },
  { value: 'GBP', label: 'GBP - British Pound' },
];
const IDLE_TIMEOUTS = [
  { value: '240', label: '4 hours' },
  { value: '480', label: '8 hours (default)' },
  { value: '720', label: '12 hours' },
  { value: '43200', label: 'Never (30 days)' },
];
const DATE_FORMATS = [
  { value: 'dd/mm/yyyy', label: 'dd/mm/yyyy' },
  { value: 'mm/dd/yyyy', label: 'mm/dd/yyyy' },
  { value: 'yyyy-mm-dd', label: 'yyyy-mm-dd' },
];
const ROUNDING_TYPES = [
  { value: 'none', label: 'No Rounding' },
  { value: 'up', label: 'Round Up' },
  { value: 'down', label: 'Round Down' },
  { value: 'nearest', label: 'Round to Nearest' },
];
const AGEING_BASES = [
  { value: 'invoice_date', label: 'Invoice Date' },
  { value: 'due_date', label: 'Due Date' },
];

interface Props {
  company: Company;
  onChange: (field: keyof Company, value: unknown) => void;
  /** True while Lockdown Date holds text it refused (the old date is still in `company`): the page blocks Save. Pass a stable setter. */
  onLockdownInvalid?: (invalid: boolean) => void;
}

export function GeneralTab({ company, onChange, onLockdownInvalid }: Props) {
  // Leaving the tab drops the refused text: the field shows the saved date again when it comes back.
  useEffect(() => () => onLockdownInvalid?.(false), [onLockdownInvalid]);
  return (
    <>
      {/* Financial Year & Lockdown */}
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4 flex items-center gap-2">
          <Lock className="h-5 w-5" /> Financial Year &amp; Lockdown
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <FinancialYearStartField company={company} onChange={onChange} />
          <YearEndChangeEntry />
          <div>
            <Select id="general-tab-default-currency" label="Default Currency" labelClassName={LABEL_CLS} options={CURRENCIES}
              value={company.defaultCurrency || 'ZAR'} onChange={v => onChange('defaultCurrency', v ?? 'ZAR')} />
          </div>
        </div>
        <div className="border-t border-[var(--ff-border-primary)] pt-4">
          <Toggle checked={company.lockdownEnabled} onChange={v => { if (!v) onLockdownInvalid?.(false); onChange('lockdownEnabled', v); }} label="Enable Lockdown Date" />
          <p className="text-xs text-[var(--ff-text-tertiary)] mt-1 mb-3">No transactions can be processed or edited with a date up to and including the lockdown date.</p>
          {company.lockdownEnabled && (
            <div className="max-w-xs">
              <DateField label="Lockdown Date" value={company.lockdownDate || null} onChange={(iso, v) => { onLockdownInvalid?.(!v.valid); if (v.valid) onChange('lockdownDate', iso ?? ''); }} />
            </div>
          )}
        </div>
      </section>

      {/* Session Security (PRD-10 Layer 1) */}
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Session Security</h2>
        <p className="text-xs text-[var(--ff-text-tertiary)] mb-4">
          Sign users out automatically after this much idle time (no clicks or keystrokes).
          Active sessions stay logged in for the work day regardless.
        </p>
        <div className="max-w-xs">
          <Select id="general-tab-idle-timeout" label="Idle Timeout" labelClassName={LABEL_CLS} options={IDLE_TIMEOUTS}
            value={String(company.idleTimeoutMinutes)} onChange={v => { if (v) onChange('idleTimeoutMinutes', Number(v)); }} />
        </div>
      </section>

      {/* Regional Settings */}
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Regional Settings</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div><label htmlFor="general-tab-currency-symbol" className={LABEL_CLS}>Currency Symbol</label><input id="general-tab-currency-symbol" className={INPUT_CLS} value={company.currencySymbol} onChange={e => onChange('currencySymbol', e.target.value)} /></div>
          <div>
            <Select id="general-tab-date-format" label="Date Format" labelClassName={LABEL_CLS} options={DATE_FORMATS}
              value={company.dateFormat} onChange={v => { if (v) onChange('dateFormat', v); }} />
          </div>
          <div><label htmlFor="general-tab-quantity-decimal-places" className={LABEL_CLS}>Quantity Decimal Places</label><input id="general-tab-quantity-decimal-places" type="number" min="0" max="6" className={INPUT_CLS} value={company.qtyDecimalPlaces} onChange={e => onChange('qtyDecimalPlaces', Number(e.target.value))} /></div>
          <div><label htmlFor="general-tab-value-decimal-places" className={LABEL_CLS}>Value Decimal Places</label><input id="general-tab-value-decimal-places" type="number" min="0" max="6" className={INPUT_CLS} value={company.valueDecimalPlaces} onChange={e => onChange('valueDecimalPlaces', Number(e.target.value))} /></div>
          <div><label htmlFor="general-tab-hours-decimal-places" className={LABEL_CLS}>Hours Decimal Places</label><input id="general-tab-hours-decimal-places" type="number" min="0" max="6" className={INPUT_CLS} value={company.hoursDecimalPlaces} onChange={e => onChange('hoursDecimalPlaces', Number(e.target.value))} /></div>
          <div><label htmlFor="general-tab-cost-price-decimal-places" className={LABEL_CLS}>Cost Price Decimal Places</label><input id="general-tab-cost-price-decimal-places" type="number" min="0" max="6" className={INPUT_CLS} value={company.costPriceDecimalPlaces} onChange={e => onChange('costPriceDecimalPlaces', Number(e.target.value))} /></div>
          <div><label htmlFor="general-tab-selling-price-decimal-places" className={LABEL_CLS}>Selling Price Decimal Places</label><input id="general-tab-selling-price-decimal-places" type="number" min="0" max="6" className={INPUT_CLS} value={company.sellingPriceDecimalPlaces} onChange={e => onChange('sellingPriceDecimalPlaces', Number(e.target.value))} /></div>
        </div>
      </section>

      {/* Rounding */}
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Rounding</h2>
        <p className="text-xs text-[var(--ff-text-tertiary)] mb-4">Set Accounting to round customer document values.</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Select id="general-tab-rounding-type" label="Rounding Type" labelClassName={LABEL_CLS} options={ROUNDING_TYPES}
              value={company.roundingType} onChange={v => { if (v) onChange('roundingType', v); }} />
          </div>
          {company.roundingType !== 'none' && (
            <div><label htmlFor="general-tab-round-to-nearest" className={LABEL_CLS}>Round To Nearest</label><input id="general-tab-round-to-nearest" type="number" step="0.01" className={INPUT_CLS} value={company.roundToNearest} onChange={e => onChange('roundToNearest', Number(e.target.value))} /></div>
          )}
        </div>
      </section>

      {/* Customer & Supplier Settings */}
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Customer &amp; Supplier Settings</h2>
        <div className="space-y-1">
          <Toggle checked={company.warnDuplicateCustomerRef} onChange={v => onChange('warnDuplicateCustomerRef', v)} label="Warn when duplicate Customer Reference used on Customer Invoices" />
          <Toggle checked={company.warnDuplicateSupplierInv} onChange={v => onChange('warnDuplicateSupplierInv', v)} label="Warn when duplicate Supplier Invoice number used on Supplier Invoices" />
          <Toggle checked={company.displayInactiveCustomersProcessing} onChange={v => onChange('displayInactiveCustomersProcessing', v)} label="Display inactive Customers for selection when processing" />
          <Toggle checked={company.displayInactiveSuppliersProcessing} onChange={v => onChange('displayInactiveSuppliersProcessing', v)} label="Display inactive Suppliers for selection when processing" />
          <Toggle checked={company.displayInactiveCustomersReports} onChange={v => onChange('displayInactiveCustomersReports', v)} label="Display inactive Customers for selection on reports" />
          <Toggle checked={company.displayInactiveSuppliersReports} onChange={v => onChange('displayInactiveSuppliersReports', v)} label="Display inactive Suppliers for selection on reports" />
          <Toggle checked={company.useInclusiveProcessing} onChange={v => onChange('useInclusiveProcessing', v)} label="Use inclusive processing on customer/supplier documents by default" />
          <Toggle checked={company.useAccountDefaultLineType} onChange={v => onChange('useAccountDefaultLineType', v)} label="Use Account as default document line type selection" />
        </div>
      </section>

      {/* Item Settings */}
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Item Settings</h2>
        <div className="space-y-1">
          <Toggle checked={company.warnItemQtyBelowZero} onChange={v => onChange('warnItemQtyBelowZero', v)} label="Warn when Item quantities fall below zero" />
          <Toggle checked={company.blockItemQtyBelowZero} onChange={v => onChange('blockItemQtyBelowZero', v)} label="Do not allow Item quantities below zero" />
          <Toggle checked={company.warnItemCostZero} onChange={v => onChange('warnItemCostZero', v)} label="Warn when Item cost is zero" />
          <Toggle checked={company.warnItemSellingBelowCost} onChange={v => onChange('warnItemSellingBelowCost', v)} label="Warn when Item selling price is below cost" />
          <Toggle checked={company.displayInactiveItemsProcessing} onChange={v => onChange('displayInactiveItemsProcessing', v)} label="Display inactive Items for selection on document lines" />
          <Toggle checked={company.displayInactiveItemsReports} onChange={v => onChange('displayInactiveItemsReports', v)} label="Display inactive Items for selection on reports" />
          <Toggle checked={company.salesOrdersReserveQty} onChange={v => onChange('salesOrdersReserveQty', v)} label="Sales Orders Reserve Item Quantities" />
          <Toggle checked={company.displayInactiveBundles} onChange={v => onChange('displayInactiveBundles', v)} label="Display inactive Item Bundles for selection on document lines" />
        </div>
      </section>

      {/* Outstanding Balances */}
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Outstanding Balances</h2>
        <p className="text-xs text-[var(--ff-text-tertiary)] mb-4">Ageing refers to the number of days that a Customer or Supplier balance is outstanding.</p>
        <div className="space-y-3">
          <Toggle checked={company.ageingMonthly} onChange={v => onChange('ageingMonthly', v)} label="Use Monthly ageing (display unpaid invoices by calendar month)" />
          <div className="max-w-xs">
            <Select id="general-tab-run-ageing-based-on" label="Run Ageing Based On" labelClassName={LABEL_CLS} options={AGEING_BASES}
              value={company.ageingBasedOn} onChange={v => { if (v) onChange('ageingBasedOn', v); }} />
          </div>
        </div>
      </section>
    </>
  );
}
