/**
 * SupplierForm — reusable form fields for creating/editing a supplier.
 * Used by pages/accounting/suppliers/new.tsx (and future edit page).
 */

import React from 'react';

export interface SupplierFormData {
  name: string;
  company_name: string;
  email: string;
  phone: string;
  vat_number: string;
  registration_number: string;
  contact_person: string;
  payment_terms: string;
  address: string;
  category: string;
  notes: string;
  is_active: boolean;
  bank_name: string;
  bank_account_number: string;
  bank_branch_code: string;
  bank_account_type: string;
}

export const INITIAL_SUPPLIER_FORM: SupplierFormData = {
  name: '',
  company_name: '',
  email: '',
  phone: '',
  vat_number: '',
  registration_number: '',
  contact_person: '',
  payment_terms: '30',
  address: '',
  category: '',
  notes: '',
  is_active: true,
  bank_name: '',
  bank_account_number: '',
  bank_branch_code: '',
  bank_account_type: 'current',
};

const ACCOUNT_TYPES = [
  { value: 'current', label: 'Current / Cheque' },
  { value: 'savings', label: 'Savings' },
  { value: 'transmission', label: 'Transmission' },
];

const SUPPLIER_CATEGORIES = [
  'Materials', 'Services', 'Equipment', 'Subcontractor',
  'Utilities', 'Professional Services', 'Logistics', 'Other',
];

interface Props {
  form: SupplierFormData;
  onChange: (form: SupplierFormData) => void;
  fieldErrors?: Partial<Record<keyof SupplierFormData, string>>;
}

const inputClass =
  'w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] placeholder:text-[var(--ff-text-tertiary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500';

const textareaClass = `${inputClass} resize-none`;
const selectClass = `${inputClass} cursor-pointer`;

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

export function SupplierForm({ form, onChange, fieldErrors = {} }: Props) {
  function set<K extends keyof SupplierFormData>(key: K, value: SupplierFormData[K]) {
    onChange({ ...form, [key]: value });
  }

  return (
    <>
      {/* Basic Information */}
      <Card>
        <SectionTitle>Basic Information</SectionTitle>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Supplier Name" required error={fieldErrors.name}>
            <input
              type="text"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="e.g. ABC Supplies (Pty) Ltd"
              className={inputClass}
              autoFocus
            />
          </Field>
          <Field label="Company / Trading Name" hint="If different from supplier name">
            <input
              type="text"
              value={form.company_name}
              onChange={(e) => set('company_name', e.target.value)}
              placeholder="Trading name"
              className={inputClass}
            />
          </Field>
          <Field label="Email Address" error={fieldErrors.email}>
            <input
              type="email"
              value={form.email}
              onChange={(e) => set('email', e.target.value)}
              placeholder="accounts@supplier.com"
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
              placeholder="Jane Doe"
              className={inputClass}
            />
          </Field>
          <Field label="Category">
            <select
              value={form.category}
              onChange={(e) => set('category', e.target.value)}
              className={selectClass}
            >
              <option value="">Select category...</option>
              {SUPPLIER_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
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
          <Field label="Payment Terms" hint="Days until payment is due" error={fieldErrors.payment_terms}>
            <input
              type="number"
              min="0"
              value={form.payment_terms}
              onChange={(e) => set('payment_terms', e.target.value)}
              className={inputClass}
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Physical Address">
              <textarea
                value={form.address}
                onChange={(e) => set('address', e.target.value)}
                rows={3}
                placeholder="Street address, city, postal code"
                className={textareaClass}
              />
            </Field>
          </div>
        </div>
      </Card>

      {/* Bank Details */}
      <Card>
        <SectionTitle>Bank Details</SectionTitle>
        <p className="text-xs text-[var(--ff-text-tertiary)] -mt-2 mb-4">
          Required for EFT payments and batch payment runs
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Bank Name">
            <input
              type="text"
              value={form.bank_name}
              onChange={(e) => set('bank_name', e.target.value)}
              placeholder="e.g. First National Bank"
              className={inputClass}
            />
          </Field>
          <Field label="Account Type">
            <select
              value={form.bank_account_type}
              onChange={(e) => set('bank_account_type', e.target.value)}
              className={selectClass}
            >
              {ACCOUNT_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Account Number">
            <input
              type="text"
              value={form.bank_account_number}
              onChange={(e) => set('bank_account_number', e.target.value)}
              placeholder="62012345678"
              className={inputClass}
            />
          </Field>
          <Field label="Branch Code">
            <input
              type="text"
              value={form.bank_branch_code}
              onChange={(e) => set('bank_branch_code', e.target.value)}
              placeholder="250655"
              className={inputClass}
            />
          </Field>
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
              placeholder="Internal notes about this supplier..."
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
            <span className="text-sm text-[var(--ff-text-secondary)]">Active supplier</span>
          </div>
        </div>
      </Card>
    </>
  );
}
