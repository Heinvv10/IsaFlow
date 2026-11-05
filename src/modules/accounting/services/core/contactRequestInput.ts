/**
 * A REST request body as the contact write services' input. ONE parser per contact kind, used by the create (POST)
 * and the edit (PUT) route alike, so the two validate the same way (the service refuses the rest, before any SQL).
 *
 * An edit differs in one respect: a text field sent blank (or null) means "clear it" and is named in `clear`; a field
 * not sent at all is left alone. Create ignores `clear`.
 */
import type { CustomerWriteInput, AutoAllocateStrategy as CustomerStrategy } from './customerWriteService';
import { CUSTOMER_CLEARABLE } from './customerWriteService';
import type { SupplierWriteInput } from './supplierWriteService';
import { SUPPLIER_CLEARABLE } from './supplierWriteService';

type Body = Record<string, unknown>;

const str = (b: Body, k: string) => (typeof b[k] === 'string' ? (b[k] as string) : undefined);
const bool = (b: Body, k: string) => (typeof b[k] === 'boolean' ? (b[k] as boolean) : undefined);
const num = (b: Body, k: string) => {
  const v = b[k];
  return v !== undefined && v !== null && v !== '' ? Number(v) : undefined;
};

/** The service input key -> the body key, for the fields an edit may clear. */
const CUSTOMER_BODY_KEY: Record<(typeof CUSTOMER_CLEARABLE)[number], string> = {
  email: 'email', phone: 'phone', mobile: 'mobile', fax: 'fax', webAddress: 'web_address',
  vatNumber: 'vat_number', registrationNumber: 'registration_number', billingAddress: 'billing_address',
  shippingAddress: 'shipping_address', contactPerson: 'contact_person', notes: 'notes', categoryId: 'category_id',
  creditLimit: 'credit_limit', defaultVatType: 'default_vat_type', defaultPriceList: 'default_price_list',
};
const SUPPLIER_BODY_KEY: Record<(typeof SUPPLIER_CLEARABLE)[number], string> = {
  companyName: 'company_name', email: 'email', phone: 'phone', vatNumber: 'vat_number',
  registrationNumber: 'registration_number', address: 'address', contactPerson: 'contact_person',
  bankName: 'bank_name', bankBranchCode: 'bank_branch_code', bankAccountType: 'bank_account_type', notes: 'notes',
  category: 'category', whatsappNumber: 'whatsapp_number',
};

/** The input keys whose body field is present and blank or null. */
function blanked(b: Body, keys: Record<string, string>): string[] {
  return Object.entries(keys)
    .filter(([, bodyKey]) => bodyKey in b && (b[bodyKey] === null || (typeof b[bodyKey] === 'string' && (b[bodyKey] as string).trim() === '')))
    .map(([inputKey]) => inputKey);
}

export function customerInputFromBody(b: Body): CustomerWriteInput {
  return {
    name: str(b, 'name'),
    email: str(b, 'email'), phone: str(b, 'phone'), mobile: str(b, 'mobile'), fax: str(b, 'fax'),
    webAddress: str(b, 'web_address'),
    vatNumber: str(b, 'vat_number'), registrationNumber: str(b, 'registration_number'),
    billingAddress: str(b, 'billing_address'), shippingAddress: str(b, 'shipping_address'),
    contactPerson: str(b, 'contact_person'),
    paymentTerms: num(b, 'payment_terms'), paymentTermsType: str(b, 'payment_terms_type'),
    creditLimit: num(b, 'credit_limit'), isActive: bool(b, 'is_active'), notes: str(b, 'notes'),
    categoryId: str(b, 'category_id'), cashSale: bool(b, 'cash_sale'),
    openingBalance: num(b, 'opening_balance'), openingBalanceDate: str(b, 'opening_balance_date'),
    acceptsElectronicInvoices: bool(b, 'accepts_electronic_invoices'),
    // auto_allocate_strategy is the only field that decides this; the legacy boolean is accepted and ignored
    // (migration 614, see customerWriteService).
    autoAllocateStrategy: str(b, 'auto_allocate_strategy') as CustomerStrategy | undefined,
    autoAllocateReceipts: bool(b, 'auto_allocate_receipts'),
    statementDistribution: str(b, 'statement_distribution'),
    defaultDiscount: num(b, 'default_discount'), defaultVatType: str(b, 'default_vat_type'),
    subjectToDrcVat: bool(b, 'subject_to_drc_vat'),
    invoicesViewableOnline: bool(b, 'invoices_viewable_online'),
    defaultPriceList: str(b, 'default_price_list'),
  };
}

/** An edit: the opening balance is create-only, so it is dropped here; blank text fields are cleared. */
export function customerPatchFromBody(b: Body): CustomerWriteInput {
  const { openingBalance: _ob, openingBalanceDate: _obd, ...rest } = customerInputFromBody(b);
  return { ...rest, clear: blanked(b, CUSTOMER_BODY_KEY) };
}

export function supplierInputFromBody(b: Body): SupplierWriteInput {
  return {
    name: str(b, 'name'),
    companyName: str(b, 'company_name'),
    email: str(b, 'email'), phone: str(b, 'phone'),
    vatNumber: str(b, 'vat_number'), registrationNumber: str(b, 'registration_number'),
    address: str(b, 'address'), contactPerson: str(b, 'contact_person'),
    paymentTerms: num(b, 'payment_terms'), paymentTermsType: str(b, 'payment_terms_type'),
    bankName: str(b, 'bank_name'), bankAccountNumber: str(b, 'bank_account_number'),
    bankBranchCode: str(b, 'bank_branch_code'), bankAccountType: str(b, 'bank_account_type'),
    isActive: bool(b, 'is_active'), notes: str(b, 'notes'), category: str(b, 'category'),
    openingBalance: num(b, 'opening_balance'), openingBalanceDate: str(b, 'opening_balance_date'),
    whatsappNumber: str(b, 'whatsapp_number'),
    autoAllocateStrategy: str(b, 'auto_allocate_strategy') as SupplierWriteInput['autoAllocateStrategy'],
    autoAllocatePayments: bool(b, 'auto_allocate_payments'),
    subjectToDrcVat: bool(b, 'subject_to_drc_vat'),
  };
}

export function supplierPatchFromBody(b: Body): SupplierWriteInput {
  const { openingBalance: _ob, openingBalanceDate: _obd, ...rest } = supplierInputFromBody(b);
  return { ...rest, clear: blanked(b, SUPPLIER_BODY_KEY) };
}
