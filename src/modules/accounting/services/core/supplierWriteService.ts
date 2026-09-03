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
import { ContactValidationError } from './customerWriteService';

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
  paymentTerms?: number | null;
  bankName?: string | null;
  bankAccountNumber?: string | null;
  bankBranchCode?: string | null;
  bankAccountType?: string | null;
  isActive?: boolean;
  notes?: string | null;
  category?: string | null;
  openingBalance?: number | null;
  openingBalanceDate?: string | null;
  autoAllocatePayments?: boolean;
}

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

export async function createSupplier(
  companyId: string,
  input: SupplierWriteInput,
): Promise<DbRow> {
  const name = assertName(input.name);
  const rows = (await sql`
    INSERT INTO suppliers (
      company_id, name, company_name, email, phone,
      vat_number, registration_number, address, contact_person,
      payment_terms,
      bank_name, bank_account_number, bank_branch_code, bank_account_type,
      is_active, notes, category,
      opening_balance, opening_balance_date, auto_allocate_payments
    ) VALUES (
      ${companyId}::UUID,
      ${name},
      ${trimmed(input.companyName)},
      ${trimmed(input.email)},
      ${trimmed(input.phone)},
      ${trimmed(input.vatNumber)},
      ${trimmed(input.registrationNumber)},
      ${trimmed(input.address)},
      ${trimmed(input.contactPerson)},
      ${input.paymentTerms ?? 30},
      ${trimmed(input.bankName)},
      ${trimmed(input.bankAccountNumber)},
      ${trimmed(input.bankBranchCode)},
      ${trimmed(input.bankAccountType)},
      ${input.isActive ?? true},
      ${trimmed(input.notes)},
      ${trimmed(input.category)},
      ${input.openingBalance ?? 0},
      ${trimmed(input.openingBalanceDate)}::DATE,
      ${input.autoAllocatePayments ?? false}
    )
    RETURNING
      id, name, company_name, email, phone,
      vat_number, registration_number, address, contact_person,
      payment_terms,
      bank_name, bank_account_number, bank_branch_code, bank_account_type,
      is_active, notes, category,
      opening_balance, opening_balance_date, auto_allocate_payments,
      created_at
  `) as DbRow[];

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
 */
export async function updateSupplier(
  companyId: string,
  supplierId: string,
  input: SupplierWriteInput,
): Promise<DbRow | null> {
  let name: string | null = null;
  if (input.name !== undefined) {
    name = assertName(input.name);
  }

  const rows = (await sql`
    UPDATE suppliers SET
      name                = COALESCE(${name}, name),
      company_name        = COALESCE(${trimmed(input.companyName)}, company_name),
      email               = COALESCE(${trimmed(input.email)}, email),
      phone               = COALESCE(${trimmed(input.phone)}, phone),
      vat_number          = COALESCE(${trimmed(input.vatNumber)}, vat_number),
      registration_number = COALESCE(${trimmed(input.registrationNumber)}, registration_number),
      address             = COALESCE(${trimmed(input.address)}, address),
      contact_person      = COALESCE(${trimmed(input.contactPerson)}, contact_person),
      payment_terms       = COALESCE(${input.paymentTerms ?? null}, payment_terms),
      bank_name           = COALESCE(${trimmed(input.bankName)}, bank_name),
      bank_account_number = COALESCE(${trimmed(input.bankAccountNumber)}, bank_account_number),
      bank_branch_code    = COALESCE(${trimmed(input.bankBranchCode)}, bank_branch_code),
      bank_account_type   = COALESCE(${trimmed(input.bankAccountType)}, bank_account_type),
      is_active           = COALESCE(${input.isActive ?? null}, is_active),
      notes               = COALESCE(${trimmed(input.notes)}, notes),
      category            = COALESCE(${trimmed(input.category)}, category),
      auto_allocate_payments = COALESCE(${input.autoAllocatePayments ?? null}, auto_allocate_payments),
      updated_at          = NOW()
    WHERE id = ${supplierId}::UUID
      AND company_id = ${companyId}::UUID
      AND deleted_at IS NULL
    RETURNING
      id, name, company_name, email, phone,
      vat_number, registration_number, address, contact_person,
      payment_terms,
      bank_name, bank_account_number, bank_branch_code, bank_account_type,
      is_active, notes, category,
      opening_balance, opening_balance_date, auto_allocate_payments,
      created_at
  `) as DbRow[];

  if (rows.length === 0) return null;
  log.info('Supplier updated', { id: supplierId }, 'accounting');
  return rows[0]!;
}
