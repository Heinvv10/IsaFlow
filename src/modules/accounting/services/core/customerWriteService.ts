/**
 * Creating and updating customers.
 *
 * Extracted from the inline SQL in `pages/api/accounting/customers.ts` so that
 * the REST route and the MCP tools share one implementation, and BUILT for the
 * update half, which existed nowhere: the only `UPDATE customers` statements in
 * the codebase were a bulk activate/deactivate, a merge, a soft delete, and the
 * migration importer's overwrite branch. There was no way to correct a
 * customer's VAT number or payment terms through any API at all.
 *
 * That gap is not cosmetic. You could raise an invoice but not create or fix
 * the party it was for, so every migration had a manual step in the middle —
 * which is where the Sage crosswalk broke.
 *
 * TRUNCATION RULE, kept from the route: `name` is REJECTED over 255 characters
 * because it identifies the record and silently shortening it corrupts the
 * customer. Every other free-text column is varchar(255) and is truncated to
 * fit, because losing the tail of an address is not the same class of harm.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

const MAX_NAME = 255;
const MAX_TEXT = 255;

export interface CustomerWriteInput {
  name?: string;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  fax?: string | null;
  webAddress?: string | null;
  vatNumber?: string | null;
  registrationNumber?: string | null;
  billingAddress?: string | null;
  shippingAddress?: string | null;
  contactPerson?: string | null;
  paymentTerms?: number | null;
  paymentTermsType?: string | null;
  creditLimit?: number | null;
  isActive?: boolean;
  notes?: string | null;
  categoryId?: string | null;
  cashSale?: boolean;
  openingBalance?: number | null;
  openingBalanceDate?: string | null;
  acceptsElectronicInvoices?: boolean;
  autoAllocateReceipts?: boolean;
  statementDistribution?: string | null;
  defaultDiscount?: number | null;
  defaultVatType?: string | null;
  subjectToDrcVat?: boolean;
  invoicesViewableOnline?: boolean;
  defaultPriceList?: string | null;
}

export class ContactValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContactValidationError';
  }
}

function trimmed(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t ? t.slice(0, MAX_TEXT) : null;
}

function assertName(name: string | undefined): string {
  const t = typeof name === 'string' ? name.trim() : '';
  if (!t) throw new ContactValidationError('Customer name is required');
  if (t.length > MAX_NAME) {
    throw new ContactValidationError(`Customer name must not exceed ${MAX_NAME} characters`);
  }
  return t;
}

export async function createCustomer(
  companyId: string,
  input: CustomerWriteInput,
): Promise<DbRow> {
  const name = assertName(input.name);
  const rows = (await sql`
    INSERT INTO customers (
      company_id, name, email, phone, mobile, fax, web_address,
      vat_number, registration_number,
      billing_address, shipping_address, contact_person,
      payment_terms, payment_terms_type, credit_limit, is_active, notes,
      category_id, cash_sale, opening_balance, opening_balance_date,
      accepts_electronic_invoices, auto_allocate_receipts,
      statement_distribution, default_discount, default_vat_type,
      subject_to_drc_vat, invoices_viewable_online,
      default_price_list
    ) VALUES (
      ${companyId}::UUID,
      ${name},
      ${trimmed(input.email)},
      ${trimmed(input.phone)},
      ${trimmed(input.mobile)},
      ${trimmed(input.fax)},
      ${trimmed(input.webAddress)},
      ${trimmed(input.vatNumber)},
      ${trimmed(input.registrationNumber)},
      ${trimmed(input.billingAddress)},
      ${trimmed(input.shippingAddress)},
      ${trimmed(input.contactPerson)},
      ${input.paymentTerms ?? 30},
      ${trimmed(input.paymentTermsType) ?? 'days'},
      ${input.creditLimit ?? null},
      ${input.isActive ?? true},
      ${trimmed(input.notes)},
      ${trimmed(input.categoryId)}::UUID,
      ${input.cashSale ?? false},
      ${input.openingBalance ?? 0},
      ${trimmed(input.openingBalanceDate)}::DATE,
      ${input.acceptsElectronicInvoices ?? false},
      ${input.autoAllocateReceipts ?? false},
      ${trimmed(input.statementDistribution) ?? 'email'},
      ${input.defaultDiscount ?? 0},
      ${trimmed(input.defaultVatType)},
      ${input.subjectToDrcVat ?? false},
      ${input.invoicesViewableOnline ?? true},
      ${trimmed(input.defaultPriceList)}
    )
    RETURNING *
  `) as DbRow[];

  log.info('Customer created', { id: rows[0]?.id, name }, 'accounting');
  return rows[0]!;
}

/**
 * Update the fields the caller supplied and leave the rest alone.
 *
 * Every column uses `COALESCE(${value}, column)`, so an omitted field is NULL
 * here and the existing value survives. The consequence is deliberate and is
 * stated in the tool description: this cannot CLEAR a field back to NULL. A
 * shape that could would have to distinguish "absent" from "explicitly null" on
 * the wire, and an agent that gets that wrong wipes a VAT number it merely
 * failed to mention. Between the two failure modes, the one that cannot destroy
 * data is the right default.
 *
 * `is_active` and the other booleans are the exception: they are three-valued
 * here (`true`/`false`/absent), and COALESCE handles that correctly because
 * absent arrives as NULL rather than as `false`.
 *
 * Returns `null` when the customer is not in this company — the caller keeps its
 * own not-found wording so a cross-tenant probe reads like a genuine miss.
 */
export async function updateCustomer(
  companyId: string,
  customerId: string,
  input: CustomerWriteInput,
): Promise<DbRow | null> {
  // A name may be changed but never blanked: it identifies the record, and the
  // create path rejects an empty one for the same reason.
  let name: string | null = null;
  if (input.name !== undefined) {
    name = assertName(input.name);
  }

  const rows = (await sql`
    UPDATE customers SET
      name            = COALESCE(${name}, name),
      email           = COALESCE(${trimmed(input.email)}, email),
      phone           = COALESCE(${trimmed(input.phone)}, phone),
      mobile          = COALESCE(${trimmed(input.mobile)}, mobile),
      fax             = COALESCE(${trimmed(input.fax)}, fax),
      web_address     = COALESCE(${trimmed(input.webAddress)}, web_address),
      vat_number      = COALESCE(${trimmed(input.vatNumber)}, vat_number),
      registration_number = COALESCE(${trimmed(input.registrationNumber)}, registration_number),
      billing_address = COALESCE(${trimmed(input.billingAddress)}, billing_address),
      shipping_address = COALESCE(${trimmed(input.shippingAddress)}, shipping_address),
      contact_person  = COALESCE(${trimmed(input.contactPerson)}, contact_person),
      payment_terms   = COALESCE(${input.paymentTerms ?? null}, payment_terms),
      payment_terms_type = COALESCE(${trimmed(input.paymentTermsType)}, payment_terms_type),
      credit_limit    = COALESCE(${input.creditLimit ?? null}, credit_limit),
      is_active       = COALESCE(${input.isActive ?? null}, is_active),
      notes           = COALESCE(${trimmed(input.notes)}, notes),
      category_id     = COALESCE(${trimmed(input.categoryId)}::UUID, category_id),
      cash_sale       = COALESCE(${input.cashSale ?? null}, cash_sale),
      default_discount = COALESCE(${input.defaultDiscount ?? null}, default_discount),
      default_vat_type = COALESCE(${trimmed(input.defaultVatType)}, default_vat_type),
      subject_to_drc_vat = COALESCE(${input.subjectToDrcVat ?? null}, subject_to_drc_vat),
      accepts_electronic_invoices =
        COALESCE(${input.acceptsElectronicInvoices ?? null}, accepts_electronic_invoices),
      auto_allocate_receipts = COALESCE(${input.autoAllocateReceipts ?? null}, auto_allocate_receipts),
      statement_distribution = COALESCE(${trimmed(input.statementDistribution)}, statement_distribution),
      invoices_viewable_online = COALESCE(${input.invoicesViewableOnline ?? null}, invoices_viewable_online),
      default_price_list = COALESCE(${trimmed(input.defaultPriceList)}, default_price_list),
      updated_at      = NOW()
    WHERE id = ${customerId}::UUID
      AND company_id = ${companyId}::UUID
      AND deleted_at IS NULL
    RETURNING *
  `) as DbRow[];

  if (rows.length === 0) return null;
  log.info('Customer updated', { id: customerId }, 'accounting');
  return rows[0]!;
}

/**
 * `opening_balance` and `opening_balance_date` are deliberately NOT updatable.
 *
 * They are settable at creation and nowhere else, and that is correct: an
 * opening balance is the figure the books were opened with, and changing it
 * after documents have been raised against the customer silently restates every
 * period since. Correct it with a journal (`create_draft_journal` /
 * `set_opening_balance`), which leaves a trail.
 */
export const OPENING_BALANCE_IS_CREATE_ONLY = true;
