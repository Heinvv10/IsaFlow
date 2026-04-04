import { Lock } from 'lucide-react';
import { Company, Toggle, INPUT_CLS, LABEL_CLS, SECTION_CLS } from './settingsTypes';

interface Props {
  company: Company;
  onChange: (field: keyof Company, value: unknown) => void;
}

export function GeneralTab({ company, onChange }: Props) {
  return (
    <>
      {/* Financial Year & Lockdown */}
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4 flex items-center gap-2">
          <Lock className="h-5 w-5" /> Financial Year &amp; Lockdown
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <label className={LABEL_CLS}>Financial Year Start Month</label>
            <select className={INPUT_CLS} value={company.financialYearStart} onChange={e => onChange('financialYearStart', Number(e.target.value))}>
              {['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map((m, i) => (
                <option key={i + 1} value={i + 1}>{m}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={LABEL_CLS}>Default Currency</label>
            <select className={INPUT_CLS} value={company.defaultCurrency || 'ZAR'} onChange={e => onChange('defaultCurrency', e.target.value)}>
              <option value="ZAR">ZAR - South African Rand</option>
              <option value="USD">USD - US Dollar</option>
              <option value="EUR">EUR - Euro</option>
              <option value="GBP">GBP - British Pound</option>
            </select>
          </div>
        </div>
        <div className="border-t border-[var(--ff-border-primary)] pt-4">
          <Toggle checked={company.lockdownEnabled} onChange={v => onChange('lockdownEnabled', v)} label="Enable Lockdown Date" />
          <p className="text-xs text-[var(--ff-text-tertiary)] mt-1 mb-3">No transactions can be processed or edited with a date up to and including the lockdown date.</p>
          {company.lockdownEnabled && (
            <div className="max-w-xs">
              <label className={LABEL_CLS}>Lockdown Date</label>
              <input type="date" className={INPUT_CLS} value={company.lockdownDate || ''} onChange={e => onChange('lockdownDate', e.target.value)} />
            </div>
          )}
        </div>
      </section>

      {/* Regional Settings */}
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Regional Settings</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div><label className={LABEL_CLS}>Currency Symbol</label><input className={INPUT_CLS} value={company.currencySymbol} onChange={e => onChange('currencySymbol', e.target.value)} /></div>
          <div>
            <label className={LABEL_CLS}>Date Format</label>
            <select className={INPUT_CLS} value={company.dateFormat} onChange={e => onChange('dateFormat', e.target.value)}>
              <option value="dd/mm/yyyy">dd/mm/yyyy</option>
              <option value="mm/dd/yyyy">mm/dd/yyyy</option>
              <option value="yyyy-mm-dd">yyyy-mm-dd</option>
            </select>
          </div>
          <div><label className={LABEL_CLS}>Quantity Decimal Places</label><input type="number" min="0" max="6" className={INPUT_CLS} value={company.qtyDecimalPlaces} onChange={e => onChange('qtyDecimalPlaces', Number(e.target.value))} /></div>
          <div><label className={LABEL_CLS}>Value Decimal Places</label><input type="number" min="0" max="6" className={INPUT_CLS} value={company.valueDecimalPlaces} onChange={e => onChange('valueDecimalPlaces', Number(e.target.value))} /></div>
          <div><label className={LABEL_CLS}>Hours Decimal Places</label><input type="number" min="0" max="6" className={INPUT_CLS} value={company.hoursDecimalPlaces} onChange={e => onChange('hoursDecimalPlaces', Number(e.target.value))} /></div>
          <div><label className={LABEL_CLS}>Cost Price Decimal Places</label><input type="number" min="0" max="6" className={INPUT_CLS} value={company.costPriceDecimalPlaces} onChange={e => onChange('costPriceDecimalPlaces', Number(e.target.value))} /></div>
          <div><label className={LABEL_CLS}>Selling Price Decimal Places</label><input type="number" min="0" max="6" className={INPUT_CLS} value={company.sellingPriceDecimalPlaces} onChange={e => onChange('sellingPriceDecimalPlaces', Number(e.target.value))} /></div>
        </div>
      </section>

      {/* Rounding */}
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Rounding</h2>
        <p className="text-xs text-[var(--ff-text-tertiary)] mb-4">Set Accounting to round customer document values.</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className={LABEL_CLS}>Rounding Type</label>
            <select className={INPUT_CLS} value={company.roundingType} onChange={e => onChange('roundingType', e.target.value)}>
              <option value="none">No Rounding</option>
              <option value="up">Round Up</option>
              <option value="down">Round Down</option>
              <option value="nearest">Round to Nearest</option>
            </select>
          </div>
          {company.roundingType !== 'none' && (
            <div><label className={LABEL_CLS}>Round To Nearest</label><input type="number" step="0.01" className={INPUT_CLS} value={company.roundToNearest} onChange={e => onChange('roundToNearest', Number(e.target.value))} /></div>
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
            <label className={LABEL_CLS}>Run Ageing Based On</label>
            <select className={INPUT_CLS} value={company.ageingBasedOn} onChange={e => onChange('ageingBasedOn', e.target.value)}>
              <option value="invoice_date">Invoice Date</option>
              <option value="due_date">Due Date</option>
            </select>
          </div>
        </div>
      </section>
    </>
  );
}
