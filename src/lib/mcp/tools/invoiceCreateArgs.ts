/**
 * Argument parsing shared by the single- and bulk-create invoice tools.
 *
 * `create_supplier_invoice` / `create_draft_invoice` and their bulk siblings
 * take the same per-invoice payload, so parsing it once means an agent that
 * has learned one gets the same refusals, with the same wording, from the
 * other — and the bulk tools can answer EVERY malformed element before the
 * first write, naming the element's index the way `parseAllocations` does.
 *
 * Nothing here touches the database. Ownership of a supplier, customer or GL
 * account is a read, and the bulk tools batch those across all elements rather
 * than issuing one query per invoice.
 */
import type { SupplierInvoiceItemInput } from '@/modules/accounting/types/ap.types';
import { castableArgError, strArg } from './toolHelpers';

/** More lines than this on one invoice is a mistake, not a bill. */
export const MAX_LINES = 200;

export interface ParsedSupplierInvoice {
  supplierId: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string | undefined;
  taxRate: number | undefined;
  paymentTerms: string | undefined;
  reference: string | undefined;
  notes: string | undefined;
  items: SupplierInvoiceItemInput[];
  /** Every `gl_account_id` named by a line, for one batched ownership check. */
  accountIds: string[];
}

export interface ParsedCustomerInvoiceLine {
  description: string;
  quantity?: number;
  unitPrice: number;
}

export interface ParsedCustomerInvoice {
  customerId: string;
  items: ParsedCustomerInvoiceLine[];
  invoiceDate: string | undefined;
  dueDate: string | undefined;
  taxRate: number | undefined;
  notes: string | undefined;
}

/**
 * Parse and validate every supplier-invoice line BEFORE any ownership query or
 * write.
 *
 * The service rejects a non-positive quantity or a negative unit price, but it
 * does so after opening its transaction — refusing here means the whole call
 * is still pre-write, so a refusal leaves nothing behind and the agent gets the
 * offending line INDEX rather than a message it has to bisect a 200-line bill
 * to locate.
 */
export function parseSupplierLines(
  raw: unknown,
): { items: SupplierInvoiceItemInput[]; accountIds: string[] } | string {
  if (!Array.isArray(raw) || raw.length === 0) {
    return 'lines must be a non-empty array of {description, quantity, unit_price}';
  }
  if (raw.length > MAX_LINES) {
    return `too many lines (${raw.length}); the maximum is ${MAX_LINES}`;
  }

  const items: SupplierInvoiceItemInput[] = [];
  const accountIds: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    if (typeof line !== 'object' || line === null || Array.isArray(line)) {
      return `lines[${i}] must be an object`;
    }
    const o = line as Record<string, unknown>;

    const description = typeof o.description === 'string' ? o.description.trim() : '';
    if (!description) return `lines[${i}].description is required`;

    const quantity = Number(o.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return `lines[${i}].quantity must be a positive number`;
    }

    const unitPrice = Number(o.unit_price);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      return `lines[${i}].unit_price must be a non-negative number (NET of VAT)`;
    }

    let taxRate: number | undefined;
    if (o.tax_rate !== undefined && o.tax_rate !== null) {
      taxRate = Number(o.tax_rate);
      if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) {
        return `lines[${i}].tax_rate must be between 0 and 100`;
      }
    }

    let glAccountId: string | undefined;
    if (o.gl_account_id !== undefined && o.gl_account_id !== null) {
      const value = String(o.gl_account_id);
      if (castableArgError({ gl_account_id: value }, { uuid: ['gl_account_id'] })) {
        return `invalid lines[${i}].gl_account_id`;
      }
      glAccountId = value;
      accountIds.push(value);
    }

    items.push({ description, quantity, unitPrice, taxRate, glAccountId });
  }

  return { items, accountIds };
}

/** Parse one supplier-invoice payload. Returns the refusal MESSAGE on failure. */
export function parseSupplierInvoiceInput(
  args: Record<string, unknown>,
): ParsedSupplierInvoice | string {
  const supplierId = strArg(args, 'supplier_id');
  const invoiceNumber = strArg(args, 'invoice_number');
  const invoiceDate = strArg(args, 'invoice_date');
  if (!supplierId) return 'supplier_id is required';
  if (!invoiceNumber) return 'invoice_number is required';
  if (!invoiceDate) return 'invoice_date is required (YYYY-MM-DD)';

  const bad = castableArgError(args, {
    uuid: ['supplier_id'],
    date: ['invoice_date', 'due_date'],
  });
  if (bad) return bad;

  let taxRate: number | undefined;
  if (args.tax_rate !== undefined && args.tax_rate !== null) {
    taxRate = Number(args.tax_rate);
    if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) {
      return 'tax_rate must be between 0 and 100';
    }
  }

  const parsed = parseSupplierLines(args.lines);
  if (typeof parsed === 'string') return parsed;

  return {
    supplierId,
    invoiceNumber,
    invoiceDate,
    dueDate: strArg(args, 'due_date'),
    taxRate,
    paymentTerms: strArg(args, 'payment_terms'),
    reference: strArg(args, 'reference'),
    notes: strArg(args, 'notes'),
    items: parsed.items,
    accountIds: parsed.accountIds,
  };
}

/** Parse one customer-invoice payload. Returns the refusal MESSAGE on failure. */
export function parseCustomerInvoiceInput(
  args: Record<string, unknown>,
): ParsedCustomerInvoice | string {
  const bad = castableArgError(args, {
    uuid: ['customer_id'],
    date: ['invoice_date', 'due_date'],
  });
  if (bad) return bad;

  const customerId = strArg(args, 'customer_id');
  if (!customerId) return 'customer_id is required';

  const raw = args.items;
  if (!Array.isArray(raw) || raw.length === 0) {
    return 'items must be a non-empty array of {description, unit_price, quantity?}';
  }
  if (raw.length > MAX_LINES) {
    return `too many items (${raw.length}); the maximum is ${MAX_LINES}`;
  }

  const items: ParsedCustomerInvoiceLine[] = [];
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    if (typeof line !== 'object' || line === null || Array.isArray(line)) {
      return `items[${i}] must be an object`;
    }
    const o = line as Record<string, unknown>;
    const description = typeof o.description === 'string' ? o.description.trim() : '';
    if (!description) return `items[${i}].description is required`;
    // Bounds, not just finiteness — the supplier arm above checks them and so
    // does `createDraftCustomerInvoice` ("Line unit prices cannot be negative").
    // The service throwing is what stops a negative invoice being created; this
    // is about WHERE the refusal lands. Answered here it names the element and
    // the line, before the first INSERT; left to the service it surfaces
    // mid-batch, after a bulk create has already written the elements above it
    // and has to discard them.
    const unitPrice = Number(o.unit_price);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      return `items[${i}].unit_price must be a non-negative number`;
    }
    const quantity = o.quantity === undefined ? 1 : Number(o.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return `items[${i}].quantity must be a positive number`;
    }
    items.push({ description, unitPrice, quantity });
  }

  let taxRate: number | undefined;
  if (args.tax_rate !== undefined && args.tax_rate !== null) {
    taxRate = Number(args.tax_rate);
    if (!Number.isFinite(taxRate) || taxRate < 0) return 'tax_rate must be a non-negative number';
  }

  return {
    customerId,
    items,
    invoiceDate: strArg(args, 'invoice_date'),
    dueDate: strArg(args, 'due_date'),
    taxRate,
    notes: strArg(args, 'notes'),
  };
}
