/** The customer form's cards (CustomerForm composes them; opening balance and defaults are in their own files). */
import type { CustomerFormData } from '@/components/accounting/CustomerForm';
import { Card, SectionTitle, SelectField, Switch, TextAreaField, TextField, type SectionProps } from './formParts';

type Props = SectionProps<CustomerFormData>;

export function CustomerBasicSection({ form, set, fieldErrors, mode, categories }: Props & { categories: { id: string; name: string }[] }) {
  return (
    <Card>
      <SectionTitle>Basic Information</SectionTitle>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <TextField label="Customer Name" required error={fieldErrors.name} value={form.name} onChange={(v) => set('name', v)}
            placeholder="e.g. Acme Corporation" autoFocus={mode === 'create'} />
        </div>
        <SelectField label="Category" value={form.category_id} onChange={(v) => set('category_id', v)}>
          <option value="">(None)</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </SelectField>
        <TextField label="Registration Number" value={form.registration_number}
          onChange={(v) => set('registration_number', v)} placeholder="2020/123456/07" />
        <TextField label="VAT Number" value={form.vat_number} onChange={(v) => set('vat_number', v)} placeholder="4123456789" />
        <TextField label="Credit Limit" type="number" min="0" step="0.01" error={fieldErrors.credit_limit}
          value={form.credit_limit} onChange={(v) => set('credit_limit', v)} placeholder="0.00" />
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 mt-4">
        <Switch checked={form.is_active} onChange={(v) => set('is_active', v)} label="Active" />
        <Switch checked={form.cash_sale} onChange={(v) => set('cash_sale', v)} label="Cash Sale Customer" />
        <Switch checked={form.accepts_electronic_invoices} onChange={(v) => set('accepts_electronic_invoices', v)} label="Accepts Electronic Invoices" />
      </div>
    </Card>
  );
}

export function CustomerContactSection({ form, set, fieldErrors }: Props) {
  return (
    <Card>
      <SectionTitle>Contact Details</SectionTitle>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField label="Contact Name" value={form.contact_person} onChange={(v) => set('contact_person', v)} placeholder="John Smith" />
        <TextField label="Email" type="email" error={fieldErrors.email} value={form.email}
          onChange={(v) => set('email', v)} placeholder="billing@example.com" />
        <TextField label="Telephone" type="tel" value={form.phone} onChange={(v) => set('phone', v)} placeholder="+27 11 000 0000" />
        <TextField label="Mobile" type="tel" value={form.mobile} onChange={(v) => set('mobile', v)} placeholder="+27 82 000 0000" />
        <TextField label="Fax" value={form.fax} onChange={(v) => set('fax', v)} />
        <TextField label="Web Address" type="url" value={form.web_address} onChange={(v) => set('web_address', v)} placeholder="https://www.example.com" />
      </div>
    </Card>
  );
}

export function CustomerAddressSection({ form, set }: Props) {
  return (
    <Card>
      <SectionTitle>Postal Address</SectionTitle>
      <TextAreaField label="Address" value={form.billing_address} onChange={(v) => set('billing_address', v)}
        placeholder="Street address, city, postal code" />
      <div className="mt-6">
        <SectionTitle>Delivery Address</SectionTitle>
        <TextAreaField label="Address" hint="Leave blank if same as postal" value={form.shipping_address}
          onChange={(v) => set('shipping_address', v)} placeholder="Street address, city, postal code" />
      </div>
    </Card>
  );
}

export function CustomerNotesSection({ form, set }: Props) {
  return (
    <Card>
      <SectionTitle>Notes</SectionTitle>
      <TextAreaField label="Internal Notes" value={form.notes} onChange={(v) => set('notes', v)}
        placeholder="Internal notes about this customer..." />
    </Card>
  );
}
