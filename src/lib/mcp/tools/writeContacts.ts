/**
 * MCP write tools: `create_customer`, `update_customer`, `create_supplier`,
 * `update_supplier`.
 *
 * You could raise an invoice over MCP but not create the party it was for, so
 * every migration had a manual step in the middle — which is where the Sage
 * crosswalk broke. And nothing anywhere could UPDATE a customer or supplier:
 * the only `UPDATE customers` / `UPDATE suppliers` statements in the codebase
 * were a bulk activate/deactivate, a merge, a soft delete and the migration
 * importer's overwrite branch. A VAT number typed wrong stayed wrong.
 *
 * They sit on their own `write:contacts` scope rather than on `write:invoices`.
 * A supplier's BANK ACCOUNT NUMBER is editable here, and that is what a payment
 * run pays into — nobody granting "create and edit invoices" would expect to
 * have authorised it. `consentScopeCopy.test.ts` exists because that exact
 * drift happened once already with credit notes.
 *
 * None posts to the ledger, so none is `requiresPost`, and all four are free:
 * the app meters neither contact route.
 *
 * THE UPDATE TOOLS CANNOT CLEAR A FIELD. Omitted fields keep their existing
 * value (`COALESCE` in the service), because the alternative — distinguishing
 * "absent" from "explicitly null" on the wire — hands an agent a way to wipe a
 * supplier's banking details it merely failed to mention. The descriptions say
 * so rather than leaving it to be discovered.
 */
import type { McpTool } from '../types';
import {
  createCustomer,
  updateCustomer,
  ContactValidationError,
  type CustomerWriteInput,
} from '@/modules/accounting/services/core/customerWriteService';
import {
  createSupplier,
  updateSupplier,
  type SupplierWriteInput,
} from '@/modules/accounting/services/core/supplierWriteService';
import {
  customerBelongsToCompany,
  supplierBelongsToCompany,
} from '@/modules/accounting/services/core/contactDirectoryService';
import { NOT_FOUND, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

const SCOPE = 'write:contacts';

const CUSTOMER_FIELDS = {
  name: { type: 'string', maxLength: 255, description: 'Trading name. Rejected over 255 characters — it identifies the record.' },
  email: { type: 'string' },
  phone: { type: 'string' },
  mobile: { type: 'string' },
  vat_number: { type: 'string', description: 'SARS VAT registration number.' },
  registration_number: { type: 'string', description: 'CIPC company registration number.' },
  billing_address: { type: 'string' },
  shipping_address: { type: 'string' },
  contact_person: { type: 'string' },
  payment_terms: { type: 'number', description: 'Days. Default 30 on create.' },
  credit_limit: { type: 'number' },
  is_active: { type: 'boolean' },
  notes: { type: 'string' },
  default_vat_type: { type: 'string' },
  default_discount: { type: 'number', description: 'Percent.' },
  auto_allocate_receipts: { type: 'boolean', description: 'Whether receipts are matched to invoices automatically.' },
} as const;

const SUPPLIER_FIELDS = {
  name: { type: 'string', maxLength: 255, description: 'Trading name. Rejected over 255 characters — it identifies the record.' },
  // Deliberately NOT `company_name`, which is the column's name: on an MCP tool
  // that word means the TENANT, and the manifest guard that forbids a tool
  // declaring a company identifier is right to flag it. An agent reading
  // `company_name` on a supplier tool could reasonably think it selects which
  // company's books to write to, which is the exact confusion the connector's
  // company_id assertion exists to prevent.
  registered_name: { type: 'string', description: "The supplier's registered name, when it differs from its trading name." },
  email: { type: 'string' },
  phone: { type: 'string' },
  vat_number: { type: 'string' },
  registration_number: { type: 'string' },
  address: { type: 'string' },
  contact_person: { type: 'string' },
  payment_terms: { type: 'number', description: 'Days. Default 30 on create.' },
  bank_name: { type: 'string' },
  bank_account_number: { type: 'string', description: 'What a payment run pays into. Change it deliberately.' },
  bank_branch_code: { type: 'string' },
  bank_account_type: { type: 'string' },
  is_active: { type: 'boolean' },
  notes: { type: 'string' },
  category: { type: 'string' },
  auto_allocate_payments: { type: 'boolean' },
} as const;

function customerInput(args: Record<string, unknown>): CustomerWriteInput {
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
    autoAllocateReceipts: boolArg(args, 'auto_allocate_receipts'),
  };
}

function supplierInput(args: Record<string, unknown>): SupplierWriteInput {
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
    autoAllocatePayments: boolArg(args, 'auto_allocate_payments'),
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

/** Only the pre-write validation error may become a toolError; nothing else is caught. */
function validationError(err: unknown): string | null {
  return err instanceof ContactValidationError ? err.message : null;
}

export const createCustomerTool: McpTool = {
  name: 'create_customer',
  description:
    'Create a customer. Posts nothing to the ledger. name is required and is rejected over 255 '
    + 'characters; every other free-text field is truncated to 255. payment_terms defaults to 30 '
    + 'days and is_active to true. '
    + 'Does NOT set an opening balance — use set_opening_balance, which posts a real journal, so '
    + 'that the trial balance and the customer agree. Does NOT check for an existing customer of '
    + 'the same name: list_customers first if you are migrating and might already have one. '
    + 'Use update_customer to correct a customer afterwards.',
  scope: SCOPE,
  write: true,
  inputSchema: {
    type: 'object',
    properties: { ...CUSTOMER_FIELDS, idempotency_key: { type: 'string' } },
    required: ['name', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    if (!strArg(args, 'name')) return toolError('name is required');
    try {
      const row = await createCustomer(ctx.companyId, customerInput(args));
      return ok({ id: String(row.id), name: String(row.name), is_active: row.is_active });
    } catch (err) {
      const message = validationError(err);
      if (message) return toolError(message);
      throw err;
    }
  },
};

export const updateCustomerTool: McpTool = {
  name: 'update_customer',
  description:
    'Change a customer\'s details. Posts nothing to the ledger. '
    + 'Only the fields you supply are changed; anything you leave out KEEPS ITS CURRENT VALUE. '
    + 'This tool therefore CANNOT clear a field back to empty — sending an empty string is the '
    + 'same as omitting it. That is deliberate: the alternative would let a call that simply '
    + 'forgot to mention a VAT number wipe it. '
    + 'Cannot change opening_balance: that is the figure the books were opened with, and moving '
    + 'it silently restates every period since — correct it with a journal instead. Cannot delete '
    + 'a customer; set is_active false to retire one.',
  scope: SCOPE,
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      customer_id: { type: 'string', description: 'From list_customers.' },
      ...CUSTOMER_FIELDS,
      idempotency_key: { type: 'string' },
    },
    required: ['customer_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = strArg(args, 'customer_id');
    if (!id) return toolError('customer_id is required');
    const bad = guardCastableArgs(args, { uuid: ['customer_id'] });
    if (bad) return bad;

    // Ownership before the write. `customers.id` carries no (id, company_id)
    // constraint and the service's own WHERE is the only other fence; checking
    // here lets the refusal be a toolError rather than a silent zero-row update.
    if (!(await customerBelongsToCompany(ctx.companyId, id))) return toolError(NOT_FOUND);

    try {
      const row = await updateCustomer(ctx.companyId, id, customerInput(args));
      // Raced with a soft delete between the check and the write.
      if (!row) return toolError(NOT_FOUND);
      return ok({ id: String(row.id), name: String(row.name), is_active: row.is_active });
    } catch (err) {
      const message = validationError(err);
      if (message) return toolError(message);
      throw err;
    }
  },
};

export const createSupplierTool: McpTool = {
  name: 'create_supplier',
  description:
    'Create a supplier. Posts nothing to the ledger. name is required and is rejected over 255 '
    + 'characters; every other free-text field is truncated to 255. payment_terms defaults to 30 '
    + 'days and is_active to true. Banking details are optional here and are what a payment run '
    + 'pays into. '
    + 'Does NOT set an opening balance — use set_opening_balance, which posts a real journal. '
    + 'Does NOT check for an existing supplier of the same name: list_suppliers first if you are '
    + 'migrating.',
  scope: SCOPE,
  write: true,
  inputSchema: {
    type: 'object',
    properties: { ...SUPPLIER_FIELDS, idempotency_key: { type: 'string' } },
    required: ['name', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    if (!strArg(args, 'name')) return toolError('name is required');
    try {
      const row = await createSupplier(ctx.companyId, supplierInput(args));
      return ok({ id: String(row.id), name: String(row.name), is_active: row.is_active });
    } catch (err) {
      const message = validationError(err);
      if (message) return toolError(message);
      throw err;
    }
  },
};

export const updateSupplierTool: McpTool = {
  name: 'update_supplier',
  description:
    'Change a supplier\'s details, including its banking details. Posts nothing to the ledger. '
    + 'Only the fields you supply are changed; anything you leave out KEEPS ITS CURRENT VALUE, so '
    + 'this tool CANNOT clear a field back to empty — sending an empty string is the same as '
    + 'omitting it. That is deliberate: a call that simply forgot to mention bank_account_number '
    + 'must not wipe it. '
    + 'Cannot change opening_balance, and cannot delete a supplier; set is_active false to retire '
    + 'one.',
  scope: SCOPE,
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      supplier_id: { type: 'string', description: 'From list_suppliers.' },
      ...SUPPLIER_FIELDS,
      idempotency_key: { type: 'string' },
    },
    required: ['supplier_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = strArg(args, 'supplier_id');
    if (!id) return toolError('supplier_id is required');
    const bad = guardCastableArgs(args, { uuid: ['supplier_id'] });
    if (bad) return bad;
    if (!(await supplierBelongsToCompany(ctx.companyId, id))) return toolError(NOT_FOUND);

    try {
      const row = await updateSupplier(ctx.companyId, id, supplierInput(args));
      if (!row) return toolError(NOT_FOUND);
      return ok({ id: String(row.id), name: String(row.name), is_active: row.is_active });
    } catch (err) {
      const message = validationError(err);
      if (message) return toolError(message);
      throw err;
    }
  },
};
