/**
 * Customer Invoice Create Service
 *
 * Draft-invoice creation for standalone (not project-linked) customer
 * invoices. Extracted verbatim from pages/api/accounting/customer-invoices-create.ts
 * so the MCP write-tool layer calls the SAME code the HTTP route uses — no
 * parallel duplicate of the totals math, number-reservation retry, or the
 * savepointed INSERT.
 */

import { sql, withSavepoint } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { assertCustomerInCompany } from '@/modules/accounting/services/core/contactDirectoryService';
import { insertWithReservedNumber } from '@/modules/accounting/services/core/documentNumberRetry';
import type { PostingActorOpts } from '../gl/journalEntryMeta';
import { resolveDocumentCurrency } from '../shared/documentCurrency';
import { deriveRevenueDimensions } from '../gl/dimensions/dimensionDerivation';
import { isDimensionRefusal } from '../gl/dimensions/dimensionTypes';
import { assertDocumentDimensions } from '../gl/dimensions/dimensionPolicy';

type Row = DbRow;

export interface DraftInvoiceLineInput {
  description: string;
  unitPrice: number;
  quantity?: number;
  /** CC1 (FNO) / CC2 (project) / BU — posted onto this line's revenue leg (migration 870). */
  cc1Id?: string;
  cc2Id?: string;
  buId?: string;
}

export interface DraftInvoiceInput {
  clientId: string;
  invoiceDate?: string;
  dueDate?: string;
  billingPeriodStart?: string;
  billingPeriodEnd?: string;
  taxRate?: number;
  notes?: string;
  items: DraftInvoiceLineInput[];
  currencyCode?: string;
  exchangeRate?: number;
}

/** Thrown for invalid line quantities/prices — maps to a 400 at the route. */
export class InvoiceLineValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvoiceLineValidationError';
  }
}

export async function createDraftCustomerInvoice(
  companyId: string,
  userId: string,
  input: DraftInvoiceInput,
  actor?: PostingActorOpts,
): Promise<{ id: string; invoiceNumber: string }> {
  const {
    clientId, invoiceDate, dueDate, billingPeriodStart, billingPeriodEnd,
    taxRate, notes, currencyCode, exchangeRate,
  } = input;

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

  // W1 (P2.1): server-side line validation — the July-4 audit created a
  // -R115.00 invoice through this handler (no client OR server guard).
  for (const item of items) {
    const qty = Number(item?.quantity ?? 1);
    const price = Number(item?.unitPrice);
    if (!(qty > 0)) throw new InvoiceLineValidationError('Line quantities must be positive');
    if (!(price >= 0)) throw new InvoiceLineValidationError('Line unit prices cannot be negative');
  }

  // R-119: the same audit, one field over. `taxRate` comes off the request
  // body and is used below for `tax_amount` and the output-VAT journal leg. A
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

  // FX PR0: the company's own currency at exactly 1, or a foreign one only once
  // the company has enabled them — refused here, before the first write.
  const { currencyCode: invCurrencyCode, exchangeRate: invExchangeRate } =
    await resolveDocumentCurrency(companyId, currencyCode, exchangeRate, 'invoice');

  // Calculate totals (in foreign currency)
  const rate = requestedRate;
  let subtotal = 0;
  for (const item of items) {
    subtotal += (item.quantity || 1) * item.unitPrice;
  }
  subtotal = Math.round(subtotal * 100) / 100;
  const taxAmount = Math.round(subtotal * (rate / 100) * 100) / 100;
  const totalAmount = subtotal + taxAmount;
  const today = fmtDate(new Date()); // local date — toISOString rolls back a day before 02:00 SAST
  const invDate = invoiceDate || today;
  const bpStart = billingPeriodStart || null;
  const bpEnd = billingPeriodEnd || null;

  // Find project from client (optional). Wrap in a SAVEPOINT — without it,
  // a failed read here poisons the request-scoped tx (set up by withAuth for
  // RLS) and every subsequent statement in this handler returns "current
  // transaction is aborted, commands ignored until end of transaction block".
  const projectId: string | null = await withSavepoint('lookup_project', async () => {
    const projRows = (await sql`
      SELECT id FROM projects
       WHERE client_id = ${clientId}::UUID AND company_id = ${companyId}
       LIMIT 1
    `) as Row[];
    return (projRows[0]?.['id'] as string | undefined) ?? null;
  }).catch(() => null);

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
          subtotal, tax_rate, tax_amount, total_amount, invoice_date, due_date,
          notes, status, created_by,
          currency_code, exchange_rate, functional_total,
          actor_type, actor_token_jti
        ) VALUES (
          ${companyId}, ${number}, ${projectId}, ${clientId}::UUID, ${clientId}::UUID,
          ${bpStart}, ${bpEnd},
          ${subtotal}, ${rate}, ${taxAmount}, ${totalAmount}, ${invDate},
          ${dueDate || null}, ${notes || null}, 'draft', ${userId},
          ${invCurrencyCode}, ${invExchangeRate}, public.fx_functional(${totalAmount}::NUMERIC(15,2), ${invExchangeRate}::NUMERIC(18,6)),
          ${actor?.actorType ?? null}, ${actor?.actorTokenJti ?? null}
        ) RETURNING id
      `) as Row[];
      return { invoiceId: String(invRows[0]!.id), invoiceNumber: number };
    },
  );

  for (const item of items) {
    const qty = item.quantity || 1;
    const lineAmount = Math.round(qty * item.unitPrice * 100) / 100;
    await sql`
      INSERT INTO customer_invoice_items (
        invoice_id, description, unit_price, quantity, amount, tax_rate, currency_code,
        cc1_id, cc2_id, bu_id
      ) VALUES (
        ${invoiceId}::UUID, ${item.description}, ${item.unitPrice},
        ${qty}, ${lineAmount}, ${rate}, ${invCurrencyCode},
        ${item.cc1Id || null}::UUID, ${item.cc2Id || null}::UUID, ${item.buId || null}::UUID
      )
    `;
  }

  log.info('Customer invoice created', { invoiceNumber, totalAmount, currencyCode: invCurrencyCode, exchangeRate: invExchangeRate });
  return { id: invoiceId, invoiceNumber };
}
