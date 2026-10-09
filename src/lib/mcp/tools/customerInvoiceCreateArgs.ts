/**
 * Argument parsing for the customer-invoice create tools (create_draft_invoice
 * and bulk_create_customer_invoices): one payload, one set of refusals with
 * the same wording, answered for EVERY element before the first write. The
 * supplier arm and the shared limits are invoiceCreateArgs'.
 *
 * Nothing here touches the database.
 */
import { castableArgError, strArg } from './toolHelpers';
import {
  MCP_CODING_KEYS, parseLineCoding, readCodingId, type InvoiceLineCoding,
} from '@/modules/accounting/services/ar/invoiceLineCoding';
import { DIMENSION_LINE_PROPERTIES, parseDimensionRefs } from './dimensionArgs';
import type { DimensionRefs } from '@/modules/accounting/services/gl/dimensions/dimensionTypes';
import { MAX_LINES } from './invoiceCreateArgs';

export interface ParsedCustomerInvoiceLine extends InvoiceLineCoding {
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
  projectId: string | null;
  /** Per item, the cc1/cc2/bu as typed (undefined where none). */
  dimensionRefs: (DimensionRefs | undefined)[];
}

/**
 * One customer-invoice line as an agent sends it. Shared by create_draft_invoice
 * and bulk_create_customer_invoices; the transport does not validate it
 * (parseCustomerInvoiceInput does), it tells the agent what it may send.
 */
export const CUSTOMER_INVOICE_LINE_SCHEMA = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    quantity: { type: 'number', exclusiveMinimum: 0 },
    unit_price: { type: 'number', minimum: 0 },
    gl_account_id: { type: 'string', description: 'Revenue account to credit (a leaf, active revenue account). Omit for the default sales account.' },
    project_id: {
      type: 'string',
      description: 'Job (a `projects` id — what Project Profitability reads) the line\'s revenue belongs to. '
        + 'Not the CC2 project: that is `cc2`.',
    },
    ...DIMENSION_LINE_PROPERTIES,
  },
  required: ['description', 'unit_price'],
  additionalProperties: false,
} as const;

/** The keys CUSTOMER_INVOICE_LINE_SCHEMA declares — and the only ones a line may carry. */
const CUSTOMER_LINE_KEYS: ReadonlySet<string> = new Set(Object.keys(CUSTOMER_INVOICE_LINE_SCHEMA.properties));
// A Map, not an object literal: a caller's key of "constructor" or "__proto__" must find nothing.
const SNAKE_CASE_OF: ReadonlyMap<string, string> = new Map([
  ['glAccountId', 'gl_account_id'], ['projectId', 'project_id'], ['unitPrice', 'unit_price'],
  ['costCenterId', 'cc1, cc2 or bu'], ['cost_center_id', 'cc1, cc2 or bu'],
]);

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
  const dimensionRefs: (DimensionRefs | undefined)[] = [];
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    if (typeof line !== 'object' || line === null || Array.isArray(line)) {
      return `items[${i}] must be an object`;
    }
    const o = line as Record<string, unknown>;
    // The transport does not enforce additionalProperties: an unknown key — a
    // camelCase glAccountId most of all — would otherwise be dropped in
    // silence and the line posted to the default account.
    const unknownKey = Object.keys(o).find((k) => !CUSTOMER_LINE_KEYS.has(k));
    if (unknownKey !== undefined) {
      // Echoed bounded and quoted: the key is the caller's text, of any length or content.
      const shown = JSON.stringify(unknownKey.length > 64 ? `${unknownKey.slice(0, 64)}…` : unknownKey);
      const hint = SNAKE_CASE_OF.get(unknownKey);
      return `items[${i}] has ${shown}, which is not a line field${hint ? ` — did you mean ${hint}?` : ''}; `
        + `a line takes ${[...CUSTOMER_LINE_KEYS].join(', ')}`;
    }
    const description = typeof o.description === 'string' ? o.description.trim() : '';
    if (!description) return `items[${i}].description is required`;
    // Bounds, not just finiteness — the supplier arm above checks them and so
    // does `createDraftCustomerInvoice` ("Line unit prices must be numbers of zero or more").
    // The service throwing is what stops a negative invoice being created; this
    // is about WHERE the refusal lands. Answered here it names the element and
    // the line, before the first INSERT; left to the service it surfaces
    // mid-batch, after a bulk create has already written the elements above it
    // and has to discard them.
    const unitPrice = Number(o.unit_price);
    // The columns' bounds (unit_price numeric(15,2); quantity numeric(10,2), at least 0.01 once stored), as the service checks them.
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      return `items[${i}].unit_price must be a non-negative number`;
    }
    if (unitPrice >= 1e13) {
      return `items[${i}].unit_price must be below 10 000 000 000 000`;
    }
    const quantity = o.quantity === undefined ? 1 : Number(o.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return `items[${i}].quantity must be a positive number`;
    }
    if (quantity < 0.005 || quantity >= 1e8) {
      return `items[${i}].quantity must be from 0.01 to below 100 000 000`;
    }
    const coding = parseLineCoding(o, MCP_CODING_KEYS, `items[${i}]`);
    if (typeof coding === 'string') return coding;
    const dims = parseDimensionRefs(o, `items[${i}]`);
    if (typeof dims === 'string') return dims;
    dimensionRefs.push(dims);
    items.push({ description, unitPrice, quantity, ...coding });
  }
  const projectId = readCodingId(args.project_id);
  if (projectId === undefined) return 'project_id must be a UUID';

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
    projectId,
    dimensionRefs,
  };
}
