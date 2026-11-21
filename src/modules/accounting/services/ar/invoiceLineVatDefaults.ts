/**
 * The reads behind a customer invoice's per-line VAT (invoiceLineVatTypes): whether the company is registered for VAT
 * (`companies.vat_period` / `vat_system_type`, vatPeriodHelper.isVatRegistered, as quoteLineTax and withVatVendor read
 * it), and, for the lines the default chain decides, the customer's `default_vat_type` and the line item's
 * `vat_on_sales`. The line's GL account is not read (invoiceLineVatTypes). Every read is scoped to the company; an id
 * that is not a UUID, or not this company's, gives no opinion (create and the edit refuse such an item themselves,
 * before the first write; the preview never looks the coding up otherwise).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { UUID_RE } from '@/lib/validation';
import { isVatRegistered } from '@/modules/bureau/services/vatPeriodHelper';
import {
  InvoiceLineVatRefusal, resolveInvoiceLineVat, type LineVatOpinions, type ResolvedLineVat, type ResolveLineVatInput,
} from './invoiceLineVatTypes';
import { typedLinesProblem } from './invoiceVatLegs';
import type { VatPricedHeader, VatPricedLine } from './invoiceLineVatPricing';

export interface VatCodedLine { vatType?: unknown; taxRate?: unknown; itemId?: unknown }

const uuid = (v: unknown): string | null => (typeof v === 'string' && UUID_RE.test(v) ? v.toLowerCase() : null);

/** Whether the company is a VAT vendor, and the customer's default VAT type (null when none, or not this company's). */
export async function invoiceVatParties(companyId: string, customerId: string | null): Promise<{ registered: boolean; customerVat: unknown }> {
  const [row] = (await sql`
    SELECT co.vat_period, co.vat_system_type,
           (SELECT c.default_vat_type FROM customers c WHERE c.id = ${uuid(customerId)}::UUID AND c.company_id = co.id) AS customer_vat
    FROM companies co WHERE co.id = ${companyId}::UUID
  `) as DbRow[];
  return {
    registered: isVatRegistered((row?.vat_period ?? null) as string | null, (row?.vat_system_type ?? null) as string | null),
    customerVat: row?.customer_vat ?? null,
  };
}

/** Per line, what its item says; read only for the lines in `need`. */
async function lineOpinions(companyId: string, lines: readonly VatCodedLine[], need: readonly boolean[], customerVat: unknown): Promise<LineVatOpinions[]> {
  const itemIds = [...new Set(lines.flatMap((l, i) => (need[i] && uuid(l.itemId) ? [uuid(l.itemId)!] : [])))];
  const items = itemIds.length === 0 ? [] : (await sql`
    SELECT id, vat_on_sales FROM items
    WHERE company_id = ${companyId}::UUID AND id = ANY(${itemIds}::UUID[]) AND deleted_at IS NULL
  `) as DbRow[];
  const itemById = new Map(items.map((r) => [String(r.id).toLowerCase(), r]));
  return lines.map((l) => ({ customer: customerVat, item: itemById.get(uuid(l.itemId) ?? '')?.vat_on_sales ?? null }));
}

export type VatRequest = Omit<ResolveLineVatInput, 'registered' | 'defaults' | 'lines'> & { lines: readonly VatCodedLine[] };

/**
 * Each line's VAT type for an invoice of `customerId` (or `typed: false` for a non-vendor): the reads above, then the
 * contract. Throws InvoiceLineVatRefusal / InvoiceVatNotRegisteredRefusal before any write.
 */
export async function resolveInvoiceVat(companyId: string, customerId: string | null, req: VatRequest): Promise<ResolvedLineVat> {
  return resolveInvoiceVatFor(companyId, await invoiceVatParties(companyId, customerId), req);
}

/** As resolveInvoiceVat, the company's registration and the customer's default already read (the preview's one SELECT). */
export async function resolveInvoiceVatFor(
  companyId: string, parties: { registered: boolean; customerVat: unknown }, req: VatRequest,
): Promise<ResolvedLineVat> {
  const headerGiven = req.headerTaxRate !== undefined && req.headerTaxRate !== null;
  const need = req.lines.map((l, i) => parties.registered && !headerGiven && (l.vatType === undefined || l.vatType === null) && !req.kept?.[i]);
  const defaults = need.some(Boolean)
    ? await lineOpinions(companyId, req.lines, need, parties.customerVat)
    : req.lines.map(() => ({ customer: null, item: null }));
  return resolveInvoiceLineVat({ ...req, registered: parties.registered, defaults, lines: req.lines });
}

/**
 * Writer / poster parity: the priced lines held to the poster's own check (invoiceVatLegs.typedLinesProblem) before the
 * first write, so nothing is stored that approve would refuse (1 x R0.03 standard: VAT rounds to nothing). Create, the
 * draft edit (and its re-tax) and the preview call it. An untyped (legacy) invoice always passes.
 */
export function assertPricedPostable(p: { lines: readonly VatPricedLine[]; header: VatPricedHeader }, invoiceDate: string | Date): void {
  const problem = typedLinesProblem(
    p.lines.map((l) => ({ amount: l.amount, taxAmount: l.taxAmount, vatType: l.vatType, glAccountId: null, projectId: null })),
    { subtotal: p.header.subtotal, taxAmount: p.header.tax, totalAmount: p.header.total, invoiceDate, amountsAre: p.header.amountsAre },
  );
  if (problem) throw new InvoiceLineVatRefusal(`This invoice could not be approved as priced: ${problem}`);
}
