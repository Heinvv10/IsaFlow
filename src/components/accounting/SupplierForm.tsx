/**
 * SupplierForm — the supplier form fields, for creating (pages/accounting/suppliers/new.tsx) and editing
 * (pages/accounting/suppliers/[supplierId]/edit.tsx, `mode="edit"`: no opening balance, terms may be cleared to
 * "Not set", bank details read-only and masked, never inputs). The cards are in contactForm/Supplier*Section.tsx.
 */

import { localISODate } from '@/lib/dateUtils';
import type { DateGate } from '@/hooks/useDateGate';
import { UNCHOSEN_TERMS } from '@/components/accounting/paymentTermsForm';
import type { FormMode } from '@/components/accounting/contactForm/formParts';
import { SupplierAdditionalSection, SupplierBankSection, SupplierBasicSection } from '@/components/accounting/contactForm/SupplierSections';
import { SupplierAllocationSection } from '@/components/accounting/contactForm/SupplierAllocationSection';

export type AutoAllocateStrategy = 'off' | 'oldest' | 'newest';

export interface SupplierFormData {
  name: string;
  company_name: string;
  email: string;
  whatsapp_number: string;
  phone: string;
  vat_number: string;
  registration_number: string;
  contact_person: string;
  payment_terms: string;
  payment_terms_type: string;
  address: string;
  category: string;
  notes: string;
  is_active: boolean;
  bank_name: string;
  bank_account_number: string;
  bank_branch_code: string;
  bank_account_type: string;
  opening_balance: string;
  opening_balance_date: string;
  auto_allocate_strategy: AutoAllocateStrategy;
  subject_to_drc_vat: boolean;
}

export const INITIAL_SUPPLIER_FORM: SupplierFormData = {
  name: '',
  company_name: '',
  email: '',
  whatsapp_number: '',
  phone: '',
  vat_number: '',
  registration_number: '',
  contact_person: '',
  payment_terms: UNCHOSEN_TERMS.payment_terms,
  payment_terms_type: UNCHOSEN_TERMS.payment_terms_type,
  address: '',
  category: '',
  notes: '',
  is_active: true,
  bank_name: '',
  bank_account_number: '',
  bank_branch_code: '',
  bank_account_type: 'current',
  opening_balance: '',
  opening_balance_date: localISODate(),
  auto_allocate_strategy: 'off',
  subject_to_drc_vat: false,
};

interface Props {
  form: SupplierFormData;
  onChange: (form: SupplierFormData) => void;
  fieldErrors?: Partial<Record<keyof SupplierFormData, string>>;
  dates: DateGate;
  mode?: FormMode;
  /** Edit mode: the supplier whose masked bank details are shown (read-only). */
  supplierId?: string;
}

export function SupplierForm({ form, onChange, fieldErrors = {}, dates, mode = 'create', supplierId }: Props) {
  const section = {
    form, fieldErrors, mode, dates,
    set: <K extends keyof SupplierFormData>(key: K, value: SupplierFormData[K]) => onChange({ ...form, [key]: value }),
    patch: (changes: Partial<SupplierFormData>) => onChange({ ...form, ...changes }),
  };
  return (
    <>
      <SupplierBasicSection {...section} />
      <SupplierAllocationSection {...section} />
      <SupplierBankSection {...section} supplierId={supplierId} />
      <SupplierAdditionalSection {...section} />
    </>
  );
}
