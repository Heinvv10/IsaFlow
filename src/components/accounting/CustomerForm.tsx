/**
 * CustomerForm — reusable form fields for creating/editing a customer.
 * Sage-parity: all fields from Sage's New Customer form.
 */

import React from 'react';

export interface CustomerFormData {
  name: string;
  email: string;
  phone: string;
  mobile: string;
  fax: string;
  web_address: string;
  vat_number: string;
  registration_number: string;
  contact_person: string;
  payment_terms: string;
  payment_terms_type: string;
  credit_limit: string;
  billing_address: string;
  shipping_address: string;
  notes: string;
  is_active: boolean;
  category_id: string;
  cash_sale: boolean;
  opening_balance: string;
  opening_balance_date: string;
  accepts_electronic_invoices: boolean;
  auto_allocate_receipts: boolean;
  statement_distribution: string;
  default_discount: string;
  default_vat_type: string;
  subject_to_drc_vat: boolean;
  invoices_viewable_online: boolean;
}

export const INITIAL_CUSTOMER_FORM: CustomerFormData = {
  name: '',
  email: '',
  phone: '',
  mobile: '',
  fax: '',
  web_address: '',
  vat_number: '',
  registration_number: '',
  contact_person: '',
  payment_terms: '30',
  payment_terms_type: 'days',
  credit_limit: '',
  billing_address: '',
  shipping_address: '',
  notes: '',
  is_active: true,
  category_id: '',
  cash_sale: false,
  opening_balance: '',
  opening_balance_date: new Date().toISOString().split('T')[0]!,
  accepts_electronic_invoices: false,
  auto_allocate_receipts: false,
  statement_distribution: 'email',
  default_discount: '0',
  default_vat_type: '',
  subject_to_drc_vat: false,
  invoices_viewable_online: true,
};

interface Props {
  form: CustomerFormData;
  onChange: (form: CustomerFormData) => void;
  fieldErrors?: Partial<Record<keyof CustomerFormData, string>>;
  categories?: { id: string; name: string }[];
}

const inputClass =
  'w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] placeholder:text-[var(--ff-text-tertiary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500';

const textareaClass = `${inputClass} resize-none`;

interface FieldProps {
  label: string;
  required?: boolean;
  children: React.ReactNode;
  hint?: string;
  error?: string;
}

function Field({ label, required, children, hint, error }: FieldProps) {
  return (
    <div>
      <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">
        {label}
        {required && <span className="text-red-400 ml-1">*</span>}
      </label>
      {children}
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
      {hint && !error && <p className="mt-1 text-xs text-[var(--ff-text-tertiary)]">{hint}</p>}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-sm font-semibold text-[var(--ff-text-primary)] uppercase tracking-wide mb-4">
      {children}
    </h2>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-6 mb-6">
      {children}
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${checked ? 'bg-teal-600' : 'bg-[var(--ff-bg-tertiary)]'}`}>
        <span className={`inline-block h-4 w-4 rounded-full bg-white shadow ring-0 transition-transform ${checked ? 'translate-x-4' : 'translate-x-0'}`} />
      </button>
      <span className="text-sm text-[var(--ff-text-secondary)]">{label}</span>
    </div>
  );
}

export function CustomerForm({ form, onChange, fieldErrors = {}, categories = [] }: Props) {
  function set<K extends keyof CustomerFormData>(key: K, value: CustomerFormData[K]) {
    onChange({ ...form, [key]: value });
  }

  return (
    <>
      {/* Basic Information */}
      <Card>
        <SectionTitle>Basic Information</SectionTitle>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Customer Name" required error={fieldErrors.name}>
              <input type="text" value={form.name} onChange={(e) => set('name', e.target.value)}
                placeholder="e.g. Acme Corporation" className={inputClass} autoFocus />
            </Field>
          </div>
          <Field label="Category">
            <select value={form.category_id} onChange={(e) => set('category_id', e.target.value)} className={inputClass}>
              <option value="">(None)</option>
              {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Registration Number">
            <input type="text" value={form.registration_number} onChange={(e) => set('registration_number', e.target.value)}
              placeholder="2020/123456/07" className={inputClass} />
          </Field>
          <Field label="VAT Number">
            <input type="text" value={form.vat_number} onChange={(e) => set('vat_number', e.target.value)}
              placeholder="4123456789" className={inputClass} />
          </Field>
          <Field label="Credit Limit" error={fieldErrors.credit_limit}>
            <input type="number" min="0" step="0.01" value={form.credit_limit} onChange={(e) => set('credit_limit', e.target.value)}
              placeholder="0.00" className={inputClass} />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 mt-4">
          <Toggle checked={form.is_active} onChange={v => set('is_active', v)} label="Active" />
          <Toggle checked={form.cash_sale} onChange={v => set('cash_sale', v)} label="Cash Sale Customer" />
          <Toggle checked={form.accepts_electronic_invoices} onChange={v => set('accepts_electronic_invoices', v)} label="Accepts Electronic Invoices" />
        </div>
      </Card>

      {/* Opening Balance */}
      <Card>
        <SectionTitle>Opening Balance</SectionTitle>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Opening Balance">
            <input type="number" min="0" step="0.01" value={form.opening_balance} onChange={(e) => set('opening_balance', e.target.value)}
              placeholder="0.00" className={inputClass} />
          </Field>
          <Field label="Opening Balance as At">
            <input type="date" value={form.opening_balance_date} onChange={(e) => set('opening_balance_date', e.target.value)} className={inputClass} />
          </Field>
        </div>
        <div className="mt-3">
          <Toggle checked={form.auto_allocate_receipts} onChange={v => set('auto_allocate_receipts', v)} label="Auto Allocate Receipts to Oldest Invoice" />
        </div>
      </Card>

      {/* Contact Details */}
      <Card>
        <SectionTitle>Contact Details</SectionTitle>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Contact Name">
            <input type="text" value={form.contact_person} onChange={(e) => set('contact_person', e.target.value)}
              placeholder="John Smith" className={inputClass} />
          </Field>
          <Field label="Email" error={fieldErrors.email}>
            <input type="email" value={form.email} onChange={(e) => set('email', e.target.value)}
              placeholder="billing@example.com" className={inputClass} />
          </Field>
          <Field label="Telephone">
            <input type="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)}
              placeholder="+27 11 000 0000" className={inputClass} />
          </Field>
          <Field label="Mobile">
            <input type="tel" value={form.mobile} onChange={(e) => set('mobile', e.target.value)}
              placeholder="+27 82 000 0000" className={inputClass} />
          </Field>
          <Field label="Fax">
            <input type="text" value={form.fax} onChange={(e) => set('fax', e.target.value)} className={inputClass} />
          </Field>
          <Field label="Web Address">
            <input type="url" value={form.web_address} onChange={(e) => set('web_address', e.target.value)}
              placeholder="https://www.example.com" className={inputClass} />
          </Field>
        </div>
      </Card>

      {/* Addresses */}
      <Card>
        <SectionTitle>Postal Address</SectionTitle>
        <Field label="Address">
          <textarea value={form.billing_address} onChange={(e) => set('billing_address', e.target.value)}
            rows={3} placeholder="Street address, city, postal code" className={textareaClass} />
        </Field>
        <div className="mt-6">
          <SectionTitle>Delivery Address</SectionTitle>
          <Field label="Address" hint="Leave blank if same as postal">
            <textarea value={form.shipping_address} onChange={(e) => set('shipping_address', e.target.value)}
              rows={3} placeholder="Street address, city, postal code" className={textareaClass} />
          </Field>
        </div>
      </Card>

      {/* Default Settings */}
      <Card>
        <SectionTitle>Default Settings</SectionTitle>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Statement Distribution">
            <select value={form.statement_distribution} onChange={(e) => set('statement_distribution', e.target.value)} className={inputClass}>
              <option value="email">Email</option>
              <option value="print">Print</option>
              <option value="none">None</option>
            </select>
          </Field>
          <Field label="Default Discount %">
            <input type="number" min="0" max="100" step="0.01" value={form.default_discount}
              onChange={(e) => set('default_discount', e.target.value)} className={inputClass} />
          </Field>
          <Field label="Default VAT Type">
            <select value={form.default_vat_type} onChange={(e) => set('default_vat_type', e.target.value)} className={inputClass}>
              <option value="">(No Default)</option>
              <option value="standard">Standard Rate (15%)</option>
              <option value="zero">Zero Rated (0%)</option>
              <option value="exempt">Exempt</option>
            </select>
          </Field>
          <div>
            <Field label="Due Date for Payment">
              <div className="flex gap-2">
                <input type="number" min="0" value={form.payment_terms} onChange={(e) => set('payment_terms', e.target.value)}
                  className={`${inputClass} w-20`} />
                <select value={form.payment_terms_type} onChange={(e) => set('payment_terms_type', e.target.value)} className={inputClass}>
                  <option value="days">Days from Invoice</option>
                  <option value="end_of_month">End of the current Month</option>
                </select>
              </div>
            </Field>
          </div>
        </div>
        <div className="mt-3 space-y-2">
          <Toggle checked={form.invoices_viewable_online} onChange={v => set('invoices_viewable_online', v)} label="Invoices can be viewed online" />
          <Toggle checked={form.subject_to_drc_vat} onChange={v => set('subject_to_drc_vat', v)} label="Subject to DRC VAT" />
        </div>
      </Card>

      {/* Notes */}
      <Card>
        <SectionTitle>Notes</SectionTitle>
        <Field label="Internal Notes">
          <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)}
            rows={3} placeholder="Internal notes about this customer..." className={textareaClass} />
        </Field>
      </Card>
    </>
  );
}
