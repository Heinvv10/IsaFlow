/** The supplier form's cards (SupplierForm composes them; the allocation card is in SupplierAllocationSection). */
import { Toggle } from '@/components/accounting/settings/settingsTypes';
import { PaymentTermsField } from '@/components/accounting/PaymentTermsField';
import type { SupplierFormData } from '@/components/accounting/SupplierForm';
import { Card, SectionTitle, SelectField, TextAreaField, TextField, inputClass, type SectionProps } from './formParts';

type Props = SectionProps<SupplierFormData>;

const ACCOUNT_TYPES = [
  { value: 'current', label: 'Current / Cheque' },
  { value: 'savings', label: 'Savings' },
  { value: 'transmission', label: 'Transmission' },
];

const SUPPLIER_CATEGORIES = [
  'Materials', 'Services', 'Equipment', 'Subcontractor',
  'Utilities', 'Professional Services', 'Logistics', 'Other',
];

export function SupplierBasicSection({ form, set, patch, fieldErrors, mode }: Props) {
  return (
    <Card>
      <SectionTitle>Basic Information</SectionTitle>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField label="Supplier Name" required error={fieldErrors.name} value={form.name} onChange={(v) => set('name', v)}
          placeholder="e.g. ABC Supplies (Pty) Ltd" autoFocus={mode === 'create'} />
        <TextField label="Company / Trading Name" hint="If different from supplier name" value={form.company_name}
          onChange={(v) => set('company_name', v)} placeholder="Trading name" />
        <TextField label="Email Address" type="email" error={fieldErrors.email} value={form.email}
          onChange={(v) => set('email', v)} placeholder="accounts@supplier.com" />
        <TextField label="WhatsApp number (for chase)" hint="Used to send invoice chase messages via WhatsApp" type="tel"
          inputMode="tel" value={form.whatsapp_number} onChange={(v) => set('whatsapp_number', v)} placeholder="+27821234567" />
        <TextField label="Phone Number" type="tel" value={form.phone} onChange={(v) => set('phone', v)} placeholder="+27 11 000 0000" />
        <TextField label="Contact Person" value={form.contact_person} onChange={(v) => set('contact_person', v)} placeholder="Jane Doe" />
        <SelectField label="Category" value={form.category} onChange={(v) => set('category', v)}>
          <option value="">Select category...</option>
          {SUPPLIER_CATEGORIES.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
        </SelectField>
        <TextField label="VAT Number" value={form.vat_number} onChange={(v) => set('vat_number', v)} placeholder="4123456789" />
        <TextField label="Registration Number" value={form.registration_number}
          onChange={(v) => set('registration_number', v)} placeholder="2020/123456/07" />
        <PaymentTermsField
          days={form.payment_terms} type={form.payment_terms_type} error={fieldErrors.payment_terms}
          onChange={(days, type) => patch({ payment_terms: days, payment_terms_type: type })}
          inputClass={inputClass} allowNotSet={mode === 'edit'}
        />
        <div className="sm:col-span-2">
          <TextAreaField label="Physical Address" value={form.address} onChange={(v) => set('address', v)}
            placeholder="Street address, city, postal code" />
        </div>
      </div>
    </Card>
  );
}

export function SupplierBankSection({ form, set, mode }: Props) {
  return (
    <Card>
      <SectionTitle>Bank Details</SectionTitle>
      <p className="text-xs text-[var(--ff-text-tertiary)] -mt-2 mb-4">Required for EFT payments and batch payment runs</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField label="Bank Name" value={form.bank_name} onChange={(v) => set('bank_name', v)} placeholder="e.g. First National Bank" />
        <SelectField label="Account Type" value={form.bank_account_type} onChange={(v) => set('bank_account_type', v)}>
          {ACCOUNT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </SelectField>
        <TextField label="Account Number" value={form.bank_account_number} onChange={(v) => set('bank_account_number', v)}
          placeholder={mode === 'edit' ? 'Unchanged' : '62012345678'}
          hint={mode === 'edit' ? 'Leave blank to keep the current account. A new number is a bank-details change: it is recorded under your name and has to be verified again where bank verification is on.' : undefined} />
        <TextField label="Branch Code" value={form.bank_branch_code} onChange={(v) => set('bank_branch_code', v)} placeholder="250655" />
      </div>
    </Card>
  );
}

export function SupplierAdditionalSection({ form, set }: Props) {
  return (
    <Card>
      <SectionTitle>Additional</SectionTitle>
      <div className="grid grid-cols-1 gap-4">
        <TextAreaField label="Notes" value={form.notes} onChange={(v) => set('notes', v)} placeholder="Internal notes about this supplier..." />
        <Toggle checked={form.is_active} onChange={(v) => set('is_active', v)} label="Active supplier" />
        <Toggle
          checked={form.subject_to_drc_vat}
          onChange={(v) => set('subject_to_drc_vat', v)}
          label="Subject to DRC VAT (domestic reverse charge) — makes its zero-VAT bills eligible on the DRC VAT page"
        />
      </div>
    </Card>
  );
}
