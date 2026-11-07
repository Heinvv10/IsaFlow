/**
 * CustomerForm — the customer form fields, for creating (pages/accounting/customers/new.tsx) and editing
 * (pages/accounting/customers/[customerId]/edit.tsx, `mode="edit"`: no opening balance, terms may be cleared to
 * "Not set"). Sage-parity: all fields from Sage's New Customer form. The cards are in contactForm/Customer*Section.tsx.
 */

import { localISODate } from '@/lib/dateUtils';
import type { DateGate } from '@/hooks/useDateGate';
import { UNCHOSEN_TERMS } from '@/components/accounting/paymentTermsForm';
import type { FormMode } from '@/components/accounting/contactForm/formParts';
import {
  CustomerAddressSection, CustomerBasicSection, CustomerContactSection, CustomerNotesSection,
} from '@/components/accounting/contactForm/CustomerSections';
import { CustomerAllocationSection, CustomerDefaultsSection } from '@/components/accounting/contactForm/CustomerDefaultsSection';

export type AutoAllocateStrategy = 'off' | 'oldest' | 'newest';

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
  auto_allocate_strategy: AutoAllocateStrategy;
  statement_distribution: string;
  default_discount: string;
  default_vat_type: string;
  subject_to_drc_vat: boolean;
  invoices_viewable_online: boolean;
  default_price_list: string;
  /** A gl_accounts id, or '' for none (migration 966). */
  default_revenue_account_id: string;
  /** Display only, never sent: the stored account's label, marked when it can no longer be used (edit page). */
  default_revenue_account_label: string;
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
  payment_terms: UNCHOSEN_TERMS.payment_terms,
  payment_terms_type: UNCHOSEN_TERMS.payment_terms_type,
  credit_limit: '',
  billing_address: '',
  shipping_address: '',
  notes: '',
  is_active: true,
  category_id: '',
  cash_sale: false,
  opening_balance: '',
  opening_balance_date: localISODate(),
  accepts_electronic_invoices: false,
  auto_allocate_strategy: 'off',
  statement_distribution: 'email',
  default_discount: '0',
  default_vat_type: '',
  subject_to_drc_vat: false,
  invoices_viewable_online: true,
  default_price_list: '',
  default_revenue_account_id: '',
  default_revenue_account_label: '',
};

interface Props {
  form: CustomerFormData;
  onChange: (form: CustomerFormData) => void;
  fieldErrors?: Partial<Record<keyof CustomerFormData, string>>;
  dates: DateGate;
  categories?: { id: string; name: string }[];
  mode?: FormMode;
}

export function CustomerForm({ form, onChange, fieldErrors = {}, categories = [], dates, mode = 'create' }: Props) {
  const section = {
    form, fieldErrors, mode, dates,
    set: <K extends keyof CustomerFormData>(key: K, value: CustomerFormData[K]) => onChange({ ...form, [key]: value }),
    patch: (changes: Partial<CustomerFormData>) => onChange({ ...form, ...changes }),
  };
  return (
    <>
      <CustomerBasicSection {...section} categories={categories} />
      <CustomerAllocationSection {...section} />
      <CustomerContactSection {...section} />
      <CustomerAddressSection {...section} />
      <CustomerDefaultsSection {...section} />
      <CustomerNotesSection {...section} />
    </>
  );
}
