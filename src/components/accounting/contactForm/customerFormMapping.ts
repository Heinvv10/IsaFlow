/** A stored customer as the form's strings, and the form as the PUT body (blank text = clear that field). */
import { localISODate } from '@/lib/dateUtils';
import { paymentTermsBody } from '@/components/accounting/paymentTermsForm';
import type { CustomerFormData } from '@/components/accounting/CustomerForm';
import { strategyOf, termsToForm, text, type Row } from './formMapping';

export function customerToForm(row: Row): CustomerFormData {
  return {
    name: text(row, 'name'), email: text(row, 'email'), phone: text(row, 'phone'), mobile: text(row, 'mobile'),
    fax: text(row, 'fax'), web_address: text(row, 'web_address'), vat_number: text(row, 'vat_number'),
    registration_number: text(row, 'registration_number'), contact_person: text(row, 'contact_person'),
    ...termsToForm(row.payment_terms, row.payment_terms_type),
    credit_limit: text(row, 'credit_limit'), billing_address: text(row, 'billing_address'),
    shipping_address: text(row, 'shipping_address'), notes: text(row, 'notes'), is_active: row.is_active !== false,
    category_id: text(row, 'category_id'), cash_sale: row.cash_sale === true,
    opening_balance: '', opening_balance_date: localISODate(),
    accepts_electronic_invoices: row.accepts_electronic_invoices === true,
    auto_allocate_strategy: strategyOf(row.auto_allocate_strategy),
    statement_distribution: text(row, 'statement_distribution') || 'email',
    default_discount: text(row, 'default_discount') || '0', default_vat_type: text(row, 'default_vat_type'),
    subject_to_drc_vat: row.subject_to_drc_vat === true, invoices_viewable_online: row.invoices_viewable_online !== false,
    default_price_list: text(row, 'default_price_list'),
  };
}

/** `categoriesLoaded` false leaves the category out: a picker with no options must not clear the stored one. */
export function customerEditBody(form: CustomerFormData, categoriesLoaded: boolean): Record<string, unknown> {
  const t = (v: string) => v.trim();
  return {
    name: t(form.name), email: t(form.email), phone: t(form.phone), mobile: t(form.mobile), fax: t(form.fax),
    web_address: t(form.web_address), vat_number: t(form.vat_number), registration_number: t(form.registration_number),
    contact_person: t(form.contact_person), credit_limit: t(form.credit_limit),
    billing_address: t(form.billing_address), shipping_address: t(form.shipping_address), notes: t(form.notes),
    ...(categoriesLoaded ? { category_id: form.category_id } : {}),
    is_active: form.is_active, cash_sale: form.cash_sale, accepts_electronic_invoices: form.accepts_electronic_invoices,
    auto_allocate_strategy: form.auto_allocate_strategy, statement_distribution: form.statement_distribution,
    default_discount: t(form.default_discount), default_vat_type: t(form.default_vat_type),
    subject_to_drc_vat: form.subject_to_drc_vat, invoices_viewable_online: form.invoices_viewable_online,
    default_price_list: t(form.default_price_list),
    ...paymentTermsBody(form.payment_terms, form.payment_terms_type),
  };
}
