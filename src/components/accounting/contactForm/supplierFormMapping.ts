/** A stored supplier as the form's strings, and the form as the PUT body (blank text = clear that field). */
import { localISODate } from '@/lib/dateUtils';
import { TERMS_NOT_SET, normalisePaymentTermsType } from '@/modules/accounting/services/shared/paymentTerms';
import { paymentTermsBody } from '@/components/accounting/PaymentTermsField';
import type { AutoAllocateStrategy, SupplierFormData } from '@/components/accounting/SupplierForm';

type Row = Record<string, unknown>;

const text = (row: Row, key: string) => (row[key] === null || row[key] === undefined ? '' : String(row[key]));

export function strategyOf(value: unknown): AutoAllocateStrategy {
  return value === 'oldest' || value === 'newest' ? value : 'off';
}

/** Stored terms as the form's pair; terms that are not set (or carry an unknown type) show as "Not set". */
export function termsToForm(days: unknown, type: unknown): { payment_terms: string; payment_terms_type: string } {
  const kind = normalisePaymentTermsType(typeof type === 'string' ? type : null);
  return days === null || days === undefined || kind === null
    ? { payment_terms: '', payment_terms_type: TERMS_NOT_SET }
    : { payment_terms: String(days), payment_terms_type: kind };
}

export function supplierToForm(row: Row): SupplierFormData {
  return {
    name: text(row, 'name'), company_name: text(row, 'company_name'), email: text(row, 'email'),
    whatsapp_number: text(row, 'whatsapp_number'), phone: text(row, 'phone'), vat_number: text(row, 'vat_number'),
    registration_number: text(row, 'registration_number'), contact_person: text(row, 'contact_person'),
    ...termsToForm(row.payment_terms, row.payment_terms_type),
    address: text(row, 'address'), category: text(row, 'category'), notes: text(row, 'notes'),
    is_active: row.is_active !== false,
    bank_name: text(row, 'bank_name'),
    bank_account_number: '', // never sent to the browser: blank means "keep the current account"
    bank_branch_code: text(row, 'bank_branch_code'), bank_account_type: text(row, 'bank_account_type'),
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
    bank_name: t(form.bank_name), bank_account_type: t(form.bank_account_type), bank_branch_code: t(form.bank_branch_code),
    ...(t(form.bank_account_number) ? { bank_account_number: t(form.bank_account_number) } : {}),
    is_active: form.is_active, subject_to_drc_vat: form.subject_to_drc_vat,
    auto_allocate_strategy: form.auto_allocate_strategy,
    ...paymentTermsBody(form.payment_terms, form.payment_terms_type),
  };
}
