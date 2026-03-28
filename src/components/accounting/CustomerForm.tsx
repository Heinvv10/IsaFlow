/**
 * CustomerForm — reusable form fields for creating/editing a customer.
 * Used by pages/accounting/customers/new.tsx (and future edit page).
 */

import React from 'react';

export interface CustomerFormData {
  name: string;
  email: string;
  phone: string;
  vat_number: string;
  registration_number: string;
  contact_person: string;
  payment_terms: string;
  credit_limit: string;
  billing_address: string;
  shipping_address: string;
  notes: string;
  is_active: boolean;
}

export const INITIAL_CUSTOMER_FORM: CustomerFormData = {
  name: '',
  email: '',
  phone: '',
  vat_number: '',
  registration_number: '',
  contact_person: '',
  payment_terms: '30',
  credit_limit: '',
  billing_address: '',
  shipping_address: '',
  notes: '',
  is_active: true,
};

interface Props {
  form: CustomerFormData;
  onChange: (form: CustomerFormData) => void;
  fieldErrors?: Partial<Record<keyof CustomerFormData, string>>;
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

export function CustomerForm({ form, onChange, fieldErrors = {} }: Props) {
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
              <input
                type="text"
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder="e.g. Acme Corporation"
                className={inputClass}
                autoFocus
              />
            </Field>
          </div>
          <Field label="Email Address" error={fieldErrors.email}>
            <input
              type="email"
              value={form.email}
              onChange={(e) => set('email', e.target.value)}
              placeholder="billing@example.com"
              className={inputClass}
            />
          </Field>
          <Field label="Phone Number">
            <input
              type="tel"
              value={form.phone}
              onChange={(e) => set('phone', e.target.value)}
              placeholder="+27 11 000 0000"
              className={inputClass}
            />
          </Field>
          <Field label="Contact Person">
            <input
              type="text"
              value={form.contact_person}
              onChange={(e) => set('contact_person', e.target.value)}
              placeholder="John Smith"
              className={inputClass}
            />
          </Field>
          <Field label="VAT Number">
            <input
              type="text"
              value={form.vat_number}
              onChange={(e) => set('vat_number', e.target.value)}
              placeholder="4123456789"
              className={inputClass}
            />
          </Field>
          <Field label="Registration Number">
            <input
              type="text"
              value={form.registration_number}
              onChange={(e) => set('registration_number', e.target.value)}
              placeholder="2020/123456/07"
              className={inputClass}
            />
          </Field>
        </div>
      </Card>

      {/* Billing Settings */}
      <Card>
        <SectionTitle>Billing Settings</SectionTitle>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Payment Terms" hint="Days until payment is due" error={fieldErrors.payment_terms}>
            <input
              type="number"
              min="0"
              value={form.payment_terms}
              onChange={(e) => set('payment_terms', e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Credit Limit" hint="Leave blank for no limit" error={fieldErrors.credit_limit}>
            <input
              type="number"
              min="0"
              step="0.01"
              value={form.credit_limit}
              onChange={(e) => set('credit_limit', e.target.value)}
              placeholder="0.00"
              className={inputClass}
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Billing Address">
              <textarea
                value={form.billing_address}
                onChange={(e) => set('billing_address', e.target.value)}
                rows={3}
                placeholder="Street address, city, postal code"
                className={textareaClass}
              />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Shipping Address" hint="Leave blank if same as billing">
              <textarea
                value={form.shipping_address}
                onChange={(e) => set('shipping_address', e.target.value)}
                rows={3}
                placeholder="Street address, city, postal code"
                className={textareaClass}
              />
            </Field>
          </div>
        </div>
      </Card>

      {/* Additional */}
      <Card>
        <SectionTitle>Additional</SectionTitle>
        <div className="grid grid-cols-1 gap-4">
          <Field label="Notes">
            <textarea
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
              rows={3}
              placeholder="Internal notes about this customer..."
              className={textareaClass}
            />
          </Field>
          <div className="flex items-center gap-3">
            <button
              type="button"
              role="switch"
              aria-checked={form.is_active}
              onClick={() => set('is_active', !form.is_active)}
              className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${
                form.is_active ? 'bg-teal-600' : 'bg-[var(--ff-bg-tertiary)]'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 rounded-full bg-white shadow ring-0 transition-transform ${
                  form.is_active ? 'translate-x-4' : 'translate-x-0'
                }`}
              />
            </button>
            <span className="text-sm text-[var(--ff-text-secondary)]">Active customer</span>
          </div>
        </div>
      </Card>
    </>
  );
}
