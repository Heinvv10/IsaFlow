/** The customer form's opening balance (create only), auto-allocate control and default settings. */
import { useState } from 'react';
import { DateField } from '@/components/ui';
import { PaymentTermsField } from '@/components/accounting/PaymentTermsField';
import { RevenueAccountField } from './RevenueAccountField';
import type { CustomerFormData } from '@/components/accounting/CustomerForm';
import { Card, SectionTitle, SelectField, Switch, TextField, inputClass, type SectionProps } from './formParts';

type Props = SectionProps<CustomerFormData>;

export function CustomerAllocationSection({ form, set, mode, dates }: Props) {
  // Remembers the last order chosen (oldest/newest) while the toggle is off, so switching it back on restores that
  // choice instead of resetting to 'oldest' every time.
  const [lastOrder, setLastOrder] = useState<'oldest' | 'newest'>(
    form.auto_allocate_strategy !== 'off' ? form.auto_allocate_strategy : 'oldest',
  );
  const autoAllocateOn = form.auto_allocate_strategy !== 'off';

  return (
    <Card>
      <SectionTitle>{mode === 'create' ? 'Opening Balance' : 'Receipt Allocation'}</SectionTitle>
      {mode === 'create' && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField label="Opening Balance" type="number" min="0" step="0.01" value={form.opening_balance}
            onChange={(v) => set('opening_balance', v)} placeholder="0.00" />
          <DateField label="Opening Balance as At" name="opening_balance_date" value={form.opening_balance_date || null}
            onChange={dates.bind('opening_balance_date', (iso) => set('opening_balance_date', iso), form.opening_balance_date)} />
        </div>
      )}
      <div className="mt-3 flex items-center gap-3">
        <Switch
          checked={autoAllocateOn}
          onChange={(v) => set('auto_allocate_strategy', v ? lastOrder : 'off')}
          label={
            autoAllocateOn
              ? `Auto Allocate Receipts to ${form.auto_allocate_strategy === 'newest' ? 'Newest' : 'Oldest'} Invoice`
              : 'Auto Allocate Receipts'
          }
        />
        <label className="sr-only" htmlFor="customer-auto-allocate-order">Auto allocate order</label>
        <select
          id="customer-auto-allocate-order"
          disabled={!autoAllocateOn}
          // The live strategy while the toggle is ON, so a record loaded after mount shows its own order.
          value={autoAllocateOn ? form.auto_allocate_strategy : lastOrder}
          onChange={(e) => {
            const order = e.target.value as 'oldest' | 'newest';
            setLastOrder(order);
            set('auto_allocate_strategy', order);
          }}
          className={`${inputClass} w-auto disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          <option value="oldest">Oldest invoice first</option>
          <option value="newest">Newest invoice first</option>
        </select>
      </div>
    </Card>
  );
}

export function CustomerDefaultsSection({ form, set, patch, fieldErrors, mode }: Props) {
  return (
    <Card>
      <SectionTitle>Default Settings</SectionTitle>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SelectField label="Statement Distribution" value={form.statement_distribution} onChange={(v) => set('statement_distribution', v)}>
          <option value="email">Email</option>
          <option value="print">Print</option>
          <option value="none">None</option>
        </SelectField>
        <TextField label="Default Discount %" type="number" min="0" max="100" step="0.01" value={form.default_discount}
          hint={mode === 'edit' ? 'Leave blank to keep the current discount.' : undefined} onChange={(v) => set('default_discount', v)} />
        <SelectField label="Default VAT Type" value={form.default_vat_type} onChange={(v) => set('default_vat_type', v)}>
          <option value="">(No Default)</option>
          <option value="standard">Standard Rate (15%)</option>
          <option value="zero">Zero Rated (0%)</option>
          <option value="exempt">Exempt</option>
        </SelectField>
        <TextField label="Default Price List" value={form.default_price_list} onChange={(v) => set('default_price_list', v)}
          placeholder="e.g. Retail, Wholesale" />
        <PaymentTermsField
          days={form.payment_terms} type={form.payment_terms_type} error={fieldErrors.payment_terms}
          onChange={(days, type) => patch({ payment_terms: days, payment_terms_type: type })}
          inputClass={inputClass} allowDefault
        />
        <RevenueAccountField value={form.default_revenue_account_id} label={form.default_revenue_account_label}
          usable={form.default_revenue_account_usable}
          onChange={(v) => patch({ default_revenue_account_id: v, default_revenue_account_label: '', default_revenue_account_usable: true })}
          error={fieldErrors.default_revenue_account_id} />
      </div>
      <div className="mt-3 space-y-2">
        <Switch checked={form.invoices_viewable_online} onChange={(v) => set('invoices_viewable_online', v)} label="Invoices can be viewed online" />
        <Switch checked={form.subject_to_drc_vat} onChange={(v) => set('subject_to_drc_vat', v)} label="Subject to DRC VAT" />
      </div>
    </Card>
  );
}
