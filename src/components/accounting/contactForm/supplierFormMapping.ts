/** A stored supplier as the form's strings, and the form as the PUT body (blank text = clear that field; no bank fields). */
import { localISODate } from '@/lib/dateUtils';
import { paymentTermsBody } from '@/components/accounting/paymentTermsForm';
import type { SupplierFormData } from '@/components/accounting/SupplierForm';
import { strategyOf, termsToForm, text, type Row } from './formMapping';

export function supplierToForm(row: Row): SupplierFormData {
  return {
    name: text(row, 'name'), company_name: text(row, 'company_name'), email: text(row, 'email'),
    whatsapp_number: text(row, 'whatsapp_number'), phone: text(row, 'phone'), vat_number: text(row, 'vat_number'),
    registration_number: text(row, 'registration_number'), contact_person: text(row, 'contact_person'),
    ...termsToForm(row.payment_terms, row.payment_terms_type),
    address: text(row, 'address'), category: text(row, 'category'), notes: text(row, 'notes'),
    is_active: row.is_active !== false,
    // Bank details are not part of an edit: the form shows them read-only and masked (the bank panel), never as inputs.
    bank_name: '', bank_account_number: '', bank_branch_code: '', bank_account_type: '',
    opening_balance: '', opening_balance_date: localISODate(),
    auto_allocate_strategy: strategyOf(row.auto_allocate_strategy),
    subject_to_drc_vat: row.subject_to_drc_vat === true,
  };
}

export function supplierEditBody(form: SupplierFormData): Record<string, unknown> {
  const t = (v: string) => v.trim();
  return {
    name: t(form.name), company_name: t(form.company_name), email: t(form.email),
    whatsapp_number: t(form.whatsapp_number), phone: t(form.phone), contact_person: t(form.contact_person),
    category: t(form.category), vat_number: t(form.vat_number), registration_number: t(form.registration_number),
    address: t(form.address), notes: t(form.notes),
    is_active: form.is_active, subject_to_drc_vat: form.subject_to_drc_vat,
    auto_allocate_strategy: form.auto_allocate_strategy,
    ...paymentTermsBody(form.payment_terms, form.payment_terms_type),
  };
}
