/**
 * The inputSchema field maps and the args → service-input mappers shared by the
 * four contact write tools in writeContacts.ts. Split out for the 300-line cap.
 */
import type { CustomerWriteInput } from '@/modules/accounting/services/core/customerWriteService';
import type { SupplierWriteInput } from '@/modules/accounting/services/core/supplierWriteService';
import {
  AUTO_ALLOCATE_STRATEGIES,
  type AutoAllocateStrategy,
} from '@/modules/accounting/services/shared/autoAllocateStrategy';
import { strArg } from './toolHelpers';

// inputSchema.enum below is DOCUMENTATION ONLY — the MCP transport does not
// validate against it (see the house rule in allocationLine.ts). An
// out-of-range value is not silently dropped here: it is passed through to
// createCustomer/updateCustomer/createSupplier/updateSupplier, whose own
// resolveStrategy() throws a ContactValidationError naming the allowed
// values, which the existing catch block below turns into a toolError.

const AUTO_ALLOCATE_STRATEGY_DESCRIPTION =
  "'off' leaves a payment/receipt unapplied for list_unapplied_payments / list_unapplied_receipts "
  + "to clear; 'oldest' applies it to the oldest open document first (FIFO), partially settling the "
  + "last one; 'newest' applies newest first. Supersedes the deprecated boolean below.";

export const CUSTOMER_FIELDS = {
  name: { type: 'string', maxLength: 255, description: 'Trading name. Rejected over 255 characters — it identifies the record.' },
  email: { type: 'string' },
  phone: { type: 'string', maxLength: 50 },
  mobile: { type: 'string', maxLength: 50 },
  vat_number: { type: 'string', maxLength: 50, description: 'SARS VAT registration number.' },
  registration_number: { type: 'string', maxLength: 50, description: 'CIPC company registration number.' },
  billing_address: { type: 'string' },
  shipping_address: { type: 'string' },
  contact_person: { type: 'string' },
  payment_terms: { type: 'number', description: 'Days. Default 30 on create.' },
  credit_limit: { type: 'number' },
  is_active: { type: 'boolean' },
  notes: { type: 'string' },
  default_vat_type: { type: 'string', maxLength: 50 },
  default_discount: { type: 'number', description: 'Percent.' },
  auto_allocate_strategy: {
    type: 'string',
    enum: [...AUTO_ALLOCATE_STRATEGIES],
    description: AUTO_ALLOCATE_STRATEGY_DESCRIPTION,
  },
  auto_allocate_receipts: {
    type: 'boolean',
    description:
      "DEPRECATED — use auto_allocate_strategy. true maps to 'oldest', false to 'off'; "
      + 'ignored when auto_allocate_strategy is also given.',
  },
} as const;

export const SUPPLIER_FIELDS = {
  name: { type: 'string', maxLength: 255, description: 'Trading name. Rejected over 255 characters — it identifies the record.' },
  // Deliberately NOT `company_name`, which is the column's name: on an MCP tool
  // that word means the TENANT, and the manifest guard that forbids a tool
  // declaring a company identifier is right to flag it. An agent reading
  // `company_name` on a supplier tool could reasonably think it selects which
  // company's books to write to, which is the exact confusion the connector's
  // company_id assertion exists to prevent.
  registered_name: { type: 'string', description: "The supplier's registered name, when it differs from its trading name." },
  email: { type: 'string' },
  phone: { type: 'string', maxLength: 50 },
  vat_number: { type: 'string', maxLength: 50 },
  registration_number: { type: 'string', maxLength: 50 },
  address: { type: 'string' },
  contact_person: { type: 'string' },
  payment_terms: { type: 'number', description: 'Days. Default 30 on create.' },
  bank_name: { type: 'string', maxLength: 100 },
  bank_account_number: { type: 'string', maxLength: 50, description: 'What a payment run pays into. Change it deliberately.' },
  bank_branch_code: { type: 'string', maxLength: 20 },
  bank_account_type: { type: 'string', maxLength: 20 },
  is_active: { type: 'boolean' },
  notes: { type: 'string' },
  category: { type: 'string', maxLength: 100 },
  auto_allocate_strategy: {
    type: 'string',
    enum: [...AUTO_ALLOCATE_STRATEGIES],
    description: AUTO_ALLOCATE_STRATEGY_DESCRIPTION,
  },
  auto_allocate_payments: {
    type: 'boolean',
    description:
      "DEPRECATED — use auto_allocate_strategy. true maps to 'oldest', false to 'off'; "
      + 'ignored when auto_allocate_strategy is also given.',
  },
  subject_to_drc_vat: {
    type: 'boolean',
    description:
      "The supplier's supplies fall under the domestic reverse charge (DRC). Only a flagged "
      + "supplier's approved, zero-VAT bills are eligible for DRC VAT. Default false on create.",
  },
} as const;

export function customerInput(args: Record<string, unknown>): CustomerWriteInput {
  return {
    name: strArg(args, 'name'),
    email: strArg(args, 'email'),
    phone: strArg(args, 'phone'),
    mobile: strArg(args, 'mobile'),
    vatNumber: strArg(args, 'vat_number'),
    registrationNumber: strArg(args, 'registration_number'),
    billingAddress: strArg(args, 'billing_address'),
    shippingAddress: strArg(args, 'shipping_address'),
    contactPerson: strArg(args, 'contact_person'),
    paymentTerms: numArg(args, 'payment_terms'),
    creditLimit: numArg(args, 'credit_limit'),
    isActive: boolArg(args, 'is_active'),
    notes: strArg(args, 'notes'),
    defaultVatType: strArg(args, 'default_vat_type'),
    defaultDiscount: numArg(args, 'default_discount'),
    // Not validated here — an out-of-range value reaches the service's own
    // resolveStrategy() and throws, rather than being silently dropped.
    autoAllocateStrategy: strArg(args, 'auto_allocate_strategy') as AutoAllocateStrategy | undefined,
    autoAllocateReceipts: boolArg(args, 'auto_allocate_receipts'),
  };
}

export function supplierInput(args: Record<string, unknown>): SupplierWriteInput {
  return {
    name: strArg(args, 'name'),
    companyName: strArg(args, 'registered_name'),
    email: strArg(args, 'email'),
    phone: strArg(args, 'phone'),
    vatNumber: strArg(args, 'vat_number'),
    registrationNumber: strArg(args, 'registration_number'),
    address: strArg(args, 'address'),
    contactPerson: strArg(args, 'contact_person'),
    paymentTerms: numArg(args, 'payment_terms'),
    bankName: strArg(args, 'bank_name'),
    bankAccountNumber: strArg(args, 'bank_account_number'),
    bankBranchCode: strArg(args, 'bank_branch_code'),
    bankAccountType: strArg(args, 'bank_account_type'),
    isActive: boolArg(args, 'is_active'),
    notes: strArg(args, 'notes'),
    category: strArg(args, 'category'),
    // Not validated here — an out-of-range value reaches the service's own
    // resolveStrategy() and throws, rather than being silently dropped.
    autoAllocateStrategy: strArg(args, 'auto_allocate_strategy') as AutoAllocateStrategy | undefined,
    autoAllocatePayments: boolArg(args, 'auto_allocate_payments'),
    subjectToDrcVat: boolArg(args, 'subject_to_drc_vat'),
  };
}

function numArg(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function boolArg(args: Record<string, unknown>, key: string): boolean | undefined {
  return typeof args[key] === 'boolean' ? (args[key] as boolean) : undefined;
}
