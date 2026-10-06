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
} from '@/modules/accounting/services/core/customerWriteService';
import {
  createSupplier,
  updateSupplier,
} from '@/modules/accounting/services/core/supplierWriteService';
import {
  customerBelongsToCompany,
  supplierBelongsToCompany,
} from '@/modules/accounting/services/core/contactDirectoryService';
import { NOT_FOUND, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';
import { CUSTOMER_FIELDS, SUPPLIER_FIELDS, customerInput, supplierInput } from './contactToolFields';

const SCOPE = 'write:contacts';

/** Only the pre-write validation error may become a toolError; nothing else is caught. */
function validationError(err: unknown): string | null {
  return err instanceof ContactValidationError ? err.message : null;
}

export const createCustomerTool: McpTool = {
  name: 'create_customer',
  description:
    'Create a customer. Posts nothing to the ledger. name is required and is rejected over 255 '
    + 'characters. phone, mobile, vat_number, registration_number and default_vat_type are '
    + 'rejected over 50; other free-text fields are truncated to 255. '
    + 'payment_terms defaults to 30 days and is_active to true. '
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
    + 'characters. phone, vat_number, registration_number and bank_account_number are rejected over '
    + '50, bank_branch_code and bank_account_type over 20, bank_name and category over 100; other '
    + 'free-text fields are truncated to 255. payment_terms defaults to 30 days and is_active to '
    + 'true. Banking details are optional here and are what a payment run '
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
      const row = await updateSupplier(ctx.companyId, id, supplierInput(args), ctx.userId);
      if (!row) return toolError(NOT_FOUND);
      return ok({ id: String(row.id), name: String(row.name), is_active: row.is_active });
    } catch (err) {
      const message = validationError(err);
      if (message) return toolError(message);
      throw err;
    }
  },
};
