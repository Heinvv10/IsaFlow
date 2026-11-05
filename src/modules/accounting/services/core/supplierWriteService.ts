/**
 * Creating and updating suppliers.
 *
 * The AP mirror of `customerWriteService`: extracted from the inline SQL in
 * `pages/api/accounting/suppliers-list.ts` so the REST route and the MCP tools
 * share one implementation, with the update half BUILT because it existed
 * nowhere. The only `UPDATE suppliers` statements in the codebase were a merge,
 * a soft delete, the capture graph's own bookkeeping, and the migration
 * importer's overwrite branch.
 *
 * Banking details are the reason this matters more on the supplier side than
 * the customer side: an account number that cannot be corrected through any API
 * is one that gets corrected in a spreadsheet instead.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { boundedText } from './customerWriteService';
import { ContactValidationError } from './contactValidationError';
import { termsColumns } from './contactTerms';
import { clearFlags } from './contactClear';
import {
  AUTO_ALLOCATE_STRATEGIES,
  parseAutoAllocateStrategy,
  type AutoAllocateStrategy,
} from '../shared/autoAllocateStrategy';
import {
  bankDetailsChange, hasBankDetails, lockSupplierBankDetails, recordBankDetailsSetter,
} from '../ap/supplierPaymentAuthors';

export type { AutoAllocateStrategy };

const MAX_NAME = 255;
const MAX_TEXT = 255;

export interface SupplierWriteInput {
  name?: string;
  companyName?: string | null;
  email?: string | null;
  phone?: string | null;
  vatNumber?: string | null;
  registrationNumber?: string | null;
  address?: string | null;
  contactPerson?: string | null;
  /** N for `paymentTermsType`; a number alone is read as invoice days. Both omitted: create stores "not set", update leaves it. */
  paymentTerms?: number | null;
  /** invoice_days | statement_days | statement_months, or not_set to clear on update. */
  paymentTermsType?: string | null;
  bankName?: string | null;
  bankAccountNumber?: string | null;
  bankBranchCode?: string | null;
  bankAccountType?: string | null;
  isActive?: boolean;
  notes?: string | null;
  category?: string | null;
  openingBalance?: number | null;
  openingBalanceDate?: string | null;
  autoAllocateStrategy?: AutoAllocateStrategy;
  /** @deprecated Legacy boolean from migration 246. Use autoAllocateStrategy — true maps to 'oldest'. */
  autoAllocatePayments?: boolean;
  /** The supplier's supplies fall under the domestic reverse charge; the one thing DRC VAT eligibility reads. */
  subjectToDrcVat?: boolean;
  /** Where invoice-chase messages go (WhatsApp). */
  whatsappNumber?: string | null;
  /** Update only: fields to set to NULL (see `contactClear`); a field in SUPPLIER_CLEARABLE. */
  clear?: readonly string[];
}

/** No bank column: nothing that clears is a bank-details change (the edit route refuses bank fields outright). */
export const SUPPLIER_CLEARABLE = [
  'companyName', 'email', 'phone', 'vatNumber', 'registrationNumber', 'address', 'contactPerson', 'notes', 'category',
  'whatsappNumber',
] as const;

function trimmed(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t ? t.slice(0, MAX_TEXT) : null;
}

function assertName(name: string | undefined): string {
  const t = typeof name === 'string' ? name.trim() : '';
  if (!t) throw new ContactValidationError('Supplier name is required');
  if (t.length > MAX_NAME) {
    throw new ContactValidationError(`Supplier name must not exceed ${MAX_NAME} characters`);
  }
  return t;
}

/**
 * The strategy to write, or `undefined` for "leave it alone" on an update.
 *
 * Takes ONLY the new field. The deprecated boolean is not a parameter because
 * it is not an input to this decision — see the note below on why it stopped
 * being one. Throws before the value can reach the DB CHECK constraint, which
 * would otherwise surface as an opaque 23514.
 */
function resolveStrategy(
  strategy: string | undefined,
): AutoAllocateStrategy | undefined {
  if (strategy !== undefined) {
    const parsed = parseAutoAllocateStrategy(strategy);
    if (!parsed) {
      throw new ContactValidationError(
        `auto_allocate_strategy must be one of: ${AUTO_ALLOCATE_STRATEGIES.join(', ')}`,
      );
    }
    return parsed;
  }
  // THE LEGACY BOOLEAN NO LONGER TURNS ANYTHING ON, AND IS NO LONGER READ
  // HERE AT ALL. It used to map true ->
  // 'oldest', which made it the last path by which a contact could arrive at a
  // strategy nobody chose — reachable by any caller still sending the old
  // field: an external API consumer, an import, or the previous build during a
  // rolling deploy. Migration 614 refused to carry the old ticks over for
  // exactly that reason (nothing ever read them, so nobody consented to cash
  // application by ticking one); honouring the same tick when it arrives over
  // the wire would have re-opened the door the migration closed. Nothing
  // in-tree sends it — the forms, the REST routes and the MCP contact tools all
  // moved to `auto_allocate_strategy` — so an old caller's boolean is now
  // simply ignored rather than obeyed.
  return undefined;
}

/**
 * `createdBy` (R-035 PR5, decision (b)): a supplier created WITH bank details
 * records its creator as who set where its money goes; one created without
 * them writes nothing more (golden path d, on a database without 867).
 */
export async function createSupplier(
  companyId: string,
  input: SupplierWriteInput,
  createdBy: string,
): Promise<DbRow> {
  const name = assertName(input.name);
  const strategy = resolveStrategy(input.autoAllocateStrategy) ?? 'off';
  const terms = termsColumns(input);
  const rows = (await sql`
    INSERT INTO suppliers (
      company_id, name, company_name, email, phone,
      vat_number, registration_number, address, contact_person,
      payment_terms, payment_terms_type,
      bank_name, bank_account_number, bank_branch_code, bank_account_type,
      is_active, notes, category,
      opening_balance, opening_balance_date, subject_to_drc_vat, whatsapp_number,
      auto_allocate_strategy, auto_allocate_payments
    ) VALUES (
      ${companyId}::UUID,
      ${name},
      ${trimmed(input.companyName)},
      ${trimmed(input.email)},
      ${boundedText(input.phone, 'phone', 50)},
      ${boundedText(input.vatNumber, 'vat_number', 50)},
      ${boundedText(input.registrationNumber, 'registration_number', 50)},
      ${trimmed(input.address)},
      ${trimmed(input.contactPerson)},
      ${terms.days}::INT,
      ${terms.createType},
      ${boundedText(input.bankName, 'bank_name', 100)},
      ${boundedText(input.bankAccountNumber, 'bank_account_number', 50)},
      ${boundedText(input.bankBranchCode, 'bank_branch_code', 20)},
      ${boundedText(input.bankAccountType, 'bank_account_type', 20)},
      ${input.isActive ?? true},
      ${trimmed(input.notes)},
      ${boundedText(input.category, 'category', 100)},
      ${input.openingBalance ?? 0},
      ${trimmed(input.openingBalanceDate)}::DATE,
      ${input.subjectToDrcVat ?? false},
      ${trimmed(input.whatsappNumber)},
      ${strategy},
      ${strategy !== 'off'}
    )
    RETURNING
      id, name, company_name, email, phone,
      vat_number, registration_number, address, contact_person,
      payment_terms, payment_terms_type,
      bank_name, bank_account_number, bank_branch_code, bank_account_type,
      is_active, notes, category,
      opening_balance, opening_balance_date,
      auto_allocate_strategy, auto_allocate_payments, subject_to_drc_vat, whatsapp_number,
      created_at
  `) as DbRow[];

  if (hasBankDetails(rows[0]!)) await recordBankDetailsSetter(companyId, String(rows[0]!.id), createdBy, 'repointed');
  log.info('Supplier created', { id: rows[0]?.id, name }, 'accounting');
  return rows[0]!;
}

/**
 * Update the fields the caller supplied and leave the rest alone.
 *
 * `COALESCE(${value}, column)` everywhere, so an omitted field survives. As on
 * the customer side this cannot CLEAR a field to NULL, and that is the safer of
 * the two failure modes: an agent that gets an absent-versus-explicit-null
 * distinction wrong would otherwise wipe banking details it merely failed to
 * mention.
 *
 * Returns `null` when the supplier is not in this company.
 *
 * `editedBy` (R-035 PR5): a change to the bank details re-routes every unpaid
 * payment to this supplier, so its editor becomes an author of those payments
 * and their batches — and may not approve sending them.
 */
export async function updateSupplier(
  companyId: string,
  supplierId: string,
  input: SupplierWriteInput,
  editedBy: string,
): Promise<DbRow | null> {
  let name: string | null = null;
  if (input.name !== undefined) {
    name = assertName(input.name);
  }
  // undefined = "leave it alone"; COALESCE below handles that the same way it
  // handles every other omitted field.
  const strategy = resolveStrategy(input.autoAllocateStrategy);
  const terms = termsColumns(input);
  const cl = clearFlags(input.clear, SUPPLIER_CLEARABLE, input);
  // Every value validated BEFORE the first statement: a refusal runs no SQL.
  const v = {
    phone: boundedText(input.phone, 'phone', 50),
    vatNumber: boundedText(input.vatNumber, 'vat_number', 50),
    registrationNumber: boundedText(input.registrationNumber, 'registration_number', 50),
    bankName: boundedText(input.bankName, 'bank_name', 100),
    bankAccountNumber: boundedText(input.bankAccountNumber, 'bank_account_number', 50),
    bankBranchCode: boundedText(input.bankBranchCode, 'bank_branch_code', 20),
    bankAccountType: boundedText(input.bankAccountType, 'bank_account_type', 20),
    category: boundedText(input.category, 'category', 100),
  };

  // R-035 PR5: the bank details as they stand, under the row lock the UPDATE
  // below would take anyway — read here so the change is judged against the
  // row actually replaced, even when a concurrent edit committed first.
  // A write naming a bank column, or the name (approval content since migration 923), may stamp the batches paying
  // this supplier: they are locked before the row.
  const bankMayChange = [name, v.bankName, v.bankAccountNumber, v.bankBranchCode, v.bankAccountType].some((x) => x !== null);
  const before = await lockSupplierBankDetails(companyId, supplierId, bankMayChange);
  const rows = (await sql`
    UPDATE suppliers SET
      name                = COALESCE(${name}, name),
      company_name        = CASE WHEN ${cl.companyName} THEN NULL ELSE COALESCE(${trimmed(input.companyName)}, company_name) END,
      email               = CASE WHEN ${cl.email} THEN NULL ELSE COALESCE(${trimmed(input.email)}, email) END,
      phone               = CASE WHEN ${cl.phone} THEN NULL ELSE COALESCE(${v.phone}, phone) END,
      vat_number          = CASE WHEN ${cl.vatNumber} THEN NULL ELSE COALESCE(${v.vatNumber}, vat_number) END,
      registration_number = CASE WHEN ${cl.registrationNumber} THEN NULL ELSE COALESCE(${v.registrationNumber}, registration_number) END,
      address             = CASE WHEN ${cl.address} THEN NULL ELSE COALESCE(${trimmed(input.address)}, address) END,
      contact_person      = CASE WHEN ${cl.contactPerson} THEN NULL ELSE COALESCE(${trimmed(input.contactPerson)}, contact_person) END,
      whatsapp_number     = CASE WHEN ${cl.whatsappNumber} THEN NULL ELSE COALESCE(${trimmed(input.whatsappNumber)}, whatsapp_number) END,
      payment_terms       = CASE ${terms.mode}::TEXT WHEN 'set' THEN ${terms.days}::INT WHEN 'days_only' THEN ${terms.days}::INT WHEN 'clear' THEN NULL ELSE payment_terms END,
      payment_terms_type  = CASE ${terms.mode}::TEXT WHEN 'set' THEN ${terms.type}::TEXT WHEN 'days_only' THEN CASE WHEN payment_terms_type IN ('invoice_days', 'statement_days', 'statement_months', 'days', 'end_of_month') THEN payment_terms_type ELSE 'invoice_days' END WHEN 'clear' THEN NULL ELSE payment_terms_type END,
      bank_name           = COALESCE(${v.bankName}, bank_name),
      bank_account_number = COALESCE(${v.bankAccountNumber}, bank_account_number),
      bank_branch_code    = COALESCE(${v.bankBranchCode}, bank_branch_code),
      bank_account_type   = COALESCE(${v.bankAccountType}, bank_account_type),
      is_active           = COALESCE(${input.isActive ?? null}, is_active),
      notes               = CASE WHEN ${cl.notes} THEN NULL ELSE COALESCE(${trimmed(input.notes)}, notes) END,
      category            = CASE WHEN ${cl.category} THEN NULL ELSE COALESCE(${v.category}, category) END,
      auto_allocate_strategy = COALESCE(${strategy ?? null}, auto_allocate_strategy),
      auto_allocate_payments = COALESCE(
        ${strategy !== undefined ? strategy !== 'off' : null}, auto_allocate_payments
      ),
      subject_to_drc_vat  = COALESCE(${input.subjectToDrcVat ?? null}, subject_to_drc_vat),
      updated_at          = NOW()
    WHERE id = ${supplierId}::UUID
      AND company_id = ${companyId}::UUID
      AND deleted_at IS NULL
    RETURNING
      id, name, company_name, email, phone,
      vat_number, registration_number, address, contact_person,
      payment_terms, payment_terms_type,
      bank_name, bank_account_number, bank_branch_code, bank_account_type,
      is_active, notes, category,
      opening_balance, opening_balance_date,
      auto_allocate_strategy, auto_allocate_payments, subject_to_drc_vat, whatsapp_number,
      created_at
  `) as DbRow[];

  if (rows.length === 0) return null;
  const change = before ? bankDetailsChange(before, rows[0]!) : 'none';
  if (change !== 'none') await recordBankDetailsSetter(companyId, supplierId, editedBy, change);
  log.info('Supplier updated', { id: supplierId }, 'accounting');
  return rows[0]!;
}
