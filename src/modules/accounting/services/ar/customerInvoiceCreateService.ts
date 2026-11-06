/**
 * Customer Invoice Create Service
 *
 * Draft-invoice creation for standalone (not project-linked) customer
 * invoices. Extracted verbatim from pages/api/accounting/customer-invoices-create.ts
 * so the MCP write-tool layer calls the SAME code the HTTP route uses — no
 * parallel duplicate of the totals math, number-reservation retry, or the
 * savepointed INSERT.
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { DATE_RE, isRealCalendarDate } from '@/lib/validation';
import { assertCustomerInCompany } from '@/modules/accounting/services/core/contactDirectoryService';
import { insertWithReservedNumber } from '@/modules/accounting/services/core/documentNumberRetry';
import type { PostingActorOpts } from '../gl/journalEntryMeta';
import {
  HTTP_CODING_KEYS, InvoiceLineCodingRefusal, parseLineCoding, readCodingId, type InvoiceLineCoding,
} from './invoiceLineCoding';
import { invoiceLineCodingRefusal } from './invoiceLineCodingGuard';
import { resolveDocumentCurrency } from '../shared/documentCurrency';
import { invoiceLineAmount, invoiceTotals, isDiscountPercent, toColumnCents } from './invoiceLineAmount';
import { NotADecimalError, toFunctional } from '../shared/functionalAmounts';
import { deriveRevenueDimensions } from '../gl/dimensions/dimensionDerivation';
import { isDimensionRefusal } from '../gl/dimensions/dimensionTypes';
import { assertDocumentDimensions } from '../gl/dimensions/dimensionPolicy';
import { dueDateForContact } from '../core/paymentTermsResolver';
import { dueDateSourceOf } from '../shared/dueDateSource';

type Row = DbRow;

export interface DraftInvoiceLineInput {
  description: string;
  unitPrice: number;
  quantity?: number;
  /** Percent off the line, 0 to 100 — as the draft edit's PutBodySchema takes it. Not stored: the amount carries it (invoiceLineAmount.ts). */
  discount?: number;
  /** Revenue account and job (migration 874). Optional; read through parseLineCoding. */
  glAccountId?: string | null;
  projectId?: string | null;
  /** CC1 (FNO) / CC2 (project) / BU — posted onto this line's revenue leg (migration 870). */
  cc1Id?: string;
  cc2Id?: string;
  buId?: string;
}

export interface DraftInvoiceInput {
  clientId: string;
  invoiceDate?: string;
  dueDate?: string;
  /** Where a given `dueDate` came from (migration 962): a person or API caller (default) or the source document. */
  dueDateGivenAs?: 'manual' | 'document';
  billingPeriodStart?: string;
  billingPeriodEnd?: string;
  taxRate?: number;
  notes?: string;
  items: DraftInvoiceLineInput[];
  currencyCode?: string;
  exchangeRate?: number;
  /** The invoice's own project. Explicit or none — never guessed from the client. */
  projectId?: string | null;
}

/** Thrown for invalid line quantities/prices — maps to a 400 at the route. */
export class InvoiceLineValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvoiceLineValidationError';
  }
}

export interface PricedDraftLine { qty: number; price: number; amount: number }

/**
 * Each line priced as create stores it (invoiceLineAmount.ts), refused as create refuses it. Shared with the unsaved
 * preview (invoicePreviewModel.ts), so the preview's figures are create's by construction.
 */
export function priceDraftLines(items: readonly { quantity?: unknown; unitPrice?: unknown; discount?: unknown }[]): PricedDraftLine[] {
  // W1 (P2.1): server-side line validation — the July-4 audit created a
  // -R115.00 invoice through this handler (no client OR server guard). The body
  // is untyped: `true`, `"10"` or `[10]` would coerce to a number in the
  // pricing, and a negative discount would bill more than qty × price. Bounds
  // are the columns' (quantity numeric(10,2), amounts numeric(15,2)).
  const priced: PricedDraftLine[] = [];
  for (const item of items) {
    const qtyIn: unknown = item?.quantity ?? 1;
    const priceIn: unknown = item?.unitPrice;
    const discount: unknown = item?.discount ?? 0;
    if (!(typeof qtyIn === 'number' && qtyIn > 0 && qtyIn < 1e8)) {
      throw new InvoiceLineValidationError('Line quantities must be positive numbers');
    }
    if (!(typeof priceIn === 'number' && priceIn >= 0 && priceIn < 1e13)) {
      throw new InvoiceLineValidationError('Line unit prices must be numbers of zero or more');
    }
    if (!isDiscountPercent(discount)) {
      throw new InvoiceLineValidationError('Line discounts must be a number from 0 to 100, to at most two decimal places');
    }
    const qty = toColumnCents(qtyIn);
    if (qty <= 0) throw new InvoiceLineValidationError('Line quantities must be positive numbers');
    const price = toColumnCents(priceIn);
    priced.push({ qty, price, amount: invoiceLineAmount(qty, price, discount) });
  }
  return priced;
}

/** The invoice's VAT rate as create takes it: 15 when absent, refused outside 0..100. */
export function draftTaxRate(taxRate: number | undefined): number {
  // R-119: the same audit, one field over. `taxRate` comes off the request
  // body and is used by create for `tax_amount` and the output-VAT journal leg. A
  // negative rate leaves the TOTAL positive — `subtotal 1000, tax -500,
  // total 500` — so neither a total guard nor migration 692's total arm sees
  // it, while the VAT return and the GL leg go negative. Thrown as a line
  // validation error because that is what it is to the operator, and the
  // route already answers 400 for it. The MCP twins clamp `tax_rate` at the
  // schema (minimum 0); this is the HTTP route's own guard.
  const requestedRate = taxRate ?? 15;
  if (!Number.isFinite(requestedRate) || requestedRate < 0 || requestedRate > 100) {
    throw new InvoiceLineValidationError(`Tax rate must be between 0 and 100, got ${String(taxRate)}`);
  }
  return requestedRate;
}

/**
 * The invoice's subtotal, VAT and total (invoiceLineAmount.ts), refused when the total or its functional amount would
 * not fit numeric(15,2): 1e13 or more. Shared with the unsaved preview, so it refuses what create refuses.
 * A rate toFunctional cannot read (1e21 or more: no plain decimal) is a 400 too, where it was a 500.
 */
export function draftTotals(amounts: readonly number[], rate: number, exchangeRate: number): { subtotal: number; tax: number; total: number } {
  const totals = invoiceTotals(amounts, rate);
  // numeric(15,2): the total, and functional_total = fx_functional(total, rate), must fit.
  if (totals.total >= 1e13 || functionalOf(totals.total, exchangeRate) >= 1e13) {
    throw new InvoiceLineValidationError('The invoice total is too large');
  }
  return totals;
}

function functionalOf(total: number, exchangeRate: number): number {
  try {
    return toFunctional(total, exchangeRate);
  } catch (err) {
    if (err instanceof NotADecimalError) throw new InvoiceLineValidationError('The exchange rate is too large');
    throw err;
  }
}

/**
 * A YYYY-MM-DD date that is not on the calendar (2026-02-30) is refused as a 400 before the first write: Postgres
 * would throw 22008 at the INSERT, a 500. Other shapes are left to the column as before. Shared with the preview.
 */
export function assertDraftDates(dates: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(dates)) {
    if (typeof value === 'string' && DATE_RE.test(value) && !isRealCalendarDate(value)) {
      throw new InvoiceLineValidationError(`${field} is not a real date: ${value}`);
    }
  }
}

export async function createDraftCustomerInvoice(
  companyId: string,
  userId: string,
  input: DraftInvoiceInput,
  actor?: PostingActorOpts,
): Promise<{ id: string; invoiceNumber: string }> {
  const {
    clientId, invoiceDate, dueDate, dueDateGivenAs, billingPeriodStart, billingPeriodEnd,
    taxRate, notes, currencyCode, exchangeRate,
  } = input;
  assertDraftDates({ invoiceDate, dueDate, billingPeriodStart, billingPeriodEnd });

  // R-067: the tenant fence, BEFORE the first write. insertWithReservedNumber
  // below UPDATEs the company's counter, and withAuth COMMITs a 4xx returned
  // after a write — so this must precede it, not follow it.
  await assertCustomerInCompany(companyId, clientId);
  // Brief §5.4/§5.5: CC1 from the line's CC2, defaulting to the customer's FNO; a
  // conflict is refused here, before the first write. No query when no line names a dimension.
  const items = await deriveRevenueDimensions(companyId, clientId, input.items, (i) => `Line ${i + 1}`)
    .then(async (derived) => { await assertDocumentDimensions(companyId, derived); return derived; })
    .catch((err: unknown) => {
      if (isDimensionRefusal(err)) throw new InvoiceLineValidationError(err.message);
      throw err;
    });

  const priced = priceDraftLines(items);

  // Migration 874: what each line credits and is tagged with. Shape first (a
  // uuid STRING or nothing — the body is untyped), then ownership and the
  // revenue-account rules, all before the first write below.
  const codings: InvoiceLineCoding[] = [];
  for (const [i, item] of items.entries()) {
    const coding = parseLineCoding(item as unknown as Record<string, unknown>, HTTP_CODING_KEYS, `items[${i}]`);
    if (typeof coding === 'string') throw new InvoiceLineCodingRefusal(coding);
    codings.push(coding);
  }
  const projectId = readCodingId(input.projectId);
  if (projectId === undefined) throw new InvoiceLineCodingRefusal('projectId must be a UUID');
  const codingRefusal = await invoiceLineCodingRefusal(
    companyId, [...codings, { glAccountId: null, projectId }],
  );
  if (codingRefusal) throw new InvoiceLineCodingRefusal(codingRefusal);

  const requestedRate = draftTaxRate(taxRate);

  // FX PR0: the company's own currency at exactly 1, or a foreign one only once
  // the company has enabled them — refused here, before the first write.
  const { currencyCode: invCurrencyCode, exchangeRate: invExchangeRate } =
    await resolveDocumentCurrency(companyId, currencyCode, exchangeRate, 'invoice');

  // Calculate totals (in foreign currency) — invoiceLineAmount.ts, as the draft
  // edit and the new-invoice preview compute them.
  const rate = requestedRate;
  const { subtotal, tax: taxAmount, total: totalAmount } = draftTotals(priced.map((p) => p.amount), rate, invExchangeRate);
  const today = fmtDate(new Date()); // local date — toISOString rolls back a day before 02:00 SAST
  const invDate = invoiceDate || today;
  // No due date named: the customer's terms give it, else the company default (migration 960). A named date equal to
  // what the terms give (the new-invoice page prefills it) is recorded as the terms' (migration 962).
  const termsDueDate = await dueDateForContact(companyId, 'customer', clientId, invDate);
  const resolvedDueDate = dueDate || termsDueDate;
  const dueDateSource = dueDateSourceOf(dueDate, dueDateGivenAs === 'document' ? null : termsDueDate, dueDateGivenAs ?? 'manual');
  const bpStart = billingPeriodStart || null;
  const bpEnd = billingPeriodEnd || null;

  // The invoice number comes from the company's configured sequence, and
  // `insertWithReservedNumber` owns the reserve-and-retry loop every other
  // minting caller uses. What this replaced was a sixth inline copy of it,
  // still carrying the defect LOW-1 fixed in the shared helper: it renumbered on
  // ANY 23505, so a clash on a different unique constraint touched by the header
  // burned four more sequence numbers and then surfaced an error naming the
  // wrong cause. Only a clash on the numbering index renumbers now.
  //
  // The reservation runs OUTSIDE the savepoint on purpose (see the helper): a
  // failed attempt permanently burns one sequence slot rather than handing the
  // same number back forever. Gaps are acceptable here — a user can resync
  // next_number from Settings → Document Numbers.
  const { invoiceId, invoiceNumber } = await insertWithReservedNumber(
    companyId, 'customer_invoice', 'inv_insert_', 'uq_customer_invoices_company_number',
    async (number) => {
      const invRows = (await sql`
        INSERT INTO customer_invoices (
          company_id, invoice_number, project_id, customer_id, client_id,
          billing_period_start, billing_period_end,
          subtotal, tax_rate, tax_amount, total_amount, invoice_date, due_date, due_date_source,
          notes, status, created_by,
          currency_code, exchange_rate, functional_total,
          actor_type, actor_token_jti
        ) VALUES (
          ${companyId}, ${number}, ${projectId}, ${clientId}::UUID, ${clientId}::UUID,
          ${bpStart}, ${bpEnd},
          ${subtotal}, ${rate}, ${taxAmount}, ${totalAmount}, ${invDate},
          ${resolvedDueDate}, ${dueDateSource}, ${notes || null}, 'draft', ${userId},
          ${invCurrencyCode}, ${invExchangeRate}, public.fx_functional(${totalAmount}::NUMERIC(15,2), ${invExchangeRate}::NUMERIC(18,6)),
          ${actor?.actorType ?? null}, ${actor?.actorTokenJti ?? null}
        ) RETURNING id
      `) as Row[];
      return { invoiceId: String(invRows[0]!.id), invoiceNumber: number };
    },
  );

  for (const [i, item] of items.entries()) {
    const { qty, price, amount: lineAmount } = priced[i]!;
    const coding = codings[i]!;
    await sql`
      INSERT INTO customer_invoice_items (
        invoice_id, description, unit_price, quantity, amount, tax_rate, currency_code,
        gl_account_id, project_id, cc1_id, cc2_id, bu_id, line_position
      ) VALUES (
        ${invoiceId}::UUID, ${item.description}, ${price},
        ${qty}, ${lineAmount}, ${rate}, ${invCurrencyCode},
        ${coding.glAccountId}::UUID, ${coding.projectId}::UUID,
        ${item.cc1Id || null}::UUID, ${item.cc2Id || null}::UUID, ${item.buId || null}::UUID,
        ${i} -- the entry order (migration 956); created_at stays NOW(), which the approval digest relies on
      )
    `;
  }

  log.info('Customer invoice created', { invoiceNumber, totalAmount, currencyCode: invCurrencyCode, exchangeRate: invExchangeRate });
  return { id: invoiceId, invoiceNumber };
}
