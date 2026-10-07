/**
 * The draft edit behind PUT /api/accounting/customer-invoices-detail.
 *
 * Moved out of the route unchanged (it reached the 300-line cap), plus one
 * thing R-035 PR4 needs: who AUTHORED the content an approval covers.
 * `customer_invoices.content_authors` (migration 865, append-only) gains the
 * editor whenever the edit moved the approval digest — the one SQL definition
 * of the content, `approval_document_digest` — and `content_edited_at` the
 * time. The decide path refuses every author as an approver
 * (gl/approvalAuthors.ts). Stamped only when the digest actually moved, so an
 * edit to what an approval does not cover (notes, due date, billing period)
 * makes nobody an author, and putting the content back is no new authorship.
 *
 * The before-digest is read UNDER the row lock (the FOR UPDATE below), and the
 * edit and its stamp share the transaction: a concurrent edit committing
 * between the read and the write would otherwise make a reverting edit look
 * like no change, and an edit whose author went unrecorded could be approved
 * by that author (supplierInvoiceContentEditor's reasons, review LOW-1).
 */
import type { z } from 'zod';
import { withTransaction } from '@/lib/neon';
import type { PutBodySchema, PutItemSchema } from '@/lib/schemas/customerInvoiceDetail';
import type { InvoiceLineCoding } from './invoiceLineCoding';
import { invoiceLineCodingRefusal } from './invoiceLineCodingGuard';

type Row = Record<string, unknown>;

const codingOf = (it: z.infer<typeof PutItemSchema>): InvoiceLineCoding => ({
  glAccountId: it.glAccountId ? it.glAccountId.toLowerCase() : null,
  projectId: it.projectId ? it.projectId.toLowerCase() : null,
  costCenterId: it.costCenterId ? it.costCenterId.toLowerCase() : null,
});

export type CustomerInvoiceDraftEdit = z.infer<typeof PutBodySchema>;

export type CustomerInvoiceDraftEditResult =
  | { kind: 'ok' } | { kind: 'not_found' } | { kind: 'not_draft' } | { kind: 'bad_client' } | { kind: 'rate_required' }
  | { kind: 'bad_line'; message: string };

export async function editDraftCustomerInvoice(
  companyId: string, editedBy: string, edit: CustomerInvoiceDraftEdit,
): Promise<CustomerInvoiceDraftEditResult> {
  const {
    id, notes, internalNotes, dueDate,
    clientId, invoiceDate, billingPeriodStart, billingPeriodEnd,
    taxRate, currencyCode, exchangeRate, items,
  } = edit;
  const fxCode = currencyCode ? currencyCode.trim().toUpperCase() : null;
  const fxRateOverride = (typeof exchangeRate === 'number' && exchangeRate > 0) ? exchangeRate : null;

  // Wrap header UPDATE + items DELETE/INSERT in one transaction so partial
  // failures cannot leave an invoice with no line items.
  // Distinguishes 404 (no row owned by tenant) from 400 (row exists but not draft)
  // by selecting status inside the same transaction before updating.
  // Totals are computed inside the tx so we can fall back to the row's
  // existing exchange_rate when the caller edits items on an FX invoice
  // without re-supplying the rate (otherwise functional_total would silently
  // collapse to total × 1).
  return withTransaction(async (tx) => {
    const ownedRows = (await tx`
      SELECT status, currency_code, exchange_rate, tax_rate,
             approval_document_digest(company_id, 'customer_invoice', id) AS digest
        FROM customer_invoices
       WHERE id = ${id}::UUID AND company_id = ${companyId}
       FOR UPDATE
    `) as Row[];
    if (ownedRows.length === 0) {
      return { kind: 'not_found' as const };
    }
    if (String(ownedRows[0]!.status) !== 'draft') {
      return { kind: 'not_draft' as const };
    }
    const existingRate = Number(ownedRows[0]!.exchange_rate ?? 1);
    // A currency change needs its rate: recomputing at the OLD one left a ZAR
    // invoice re-labelled USD with functional_total = the USD figure, which is
    // what approval rules match on (R-035).
    if (fxCode && fxCode !== String(ownedRows[0]!.currency_code ?? 'ZAR').toUpperCase() && fxRateOverride === null) {
      return { kind: 'rate_required' as const };
    }

    // Defence-in-depth: clientId must belong to the same tenant. The FK
    // alone does not check company_id, so without this guard a caller could
    // re-point an invoice at another tenant's customer.
    if (clientId !== undefined) {
      const customerOwned = (await tx`
        SELECT 1 FROM customers
         WHERE id = ${clientId}::UUID AND company_id = ${companyId}
         LIMIT 1
      `) as Row[];
      if (customerOwned.length === 0) {
        return { kind: 'bad_client' as const };
      }
    }

    // Migration 870: the lines' revenue account / project / cost centre, under
    // the row lock and before the first write below. PutItemSchema has
    // already made each a uuid string or nothing; codingOf lower-cases it.
    const codings = (items ?? []).map(codingOf);
    if (items) {
      const refusal = await invoiceLineCodingRefusal(companyId, codings);
      if (refusal) return { kind: 'bad_line' as const, message: refusal };
    }

    let computed: { subtotal: number; tax: number; total: number; functionalTotal: number; rate: number } | null = null;
    if (items) {
      // Fall back to the invoice's existing tax_rate (not a hardcoded 15%) so
      // recomputed totals stay correct when the caller doesn't re-send taxRate.
      const existingTaxRate = Number(ownedRows[0]!.tax_rate ?? 15);
      const rate = taxRate ?? existingTaxRate;
      let subtotal = 0;
      for (const it of items) {
        const lineNet = it.quantity * it.unitPrice * (1 - ((it.discount ?? 0) / 100));
        subtotal += lineNet;
      }
      subtotal = Math.round(subtotal * 100) / 100;
      const tax = Math.round(subtotal * (rate / 100) * 100) / 100;
      const total = Math.round((subtotal + tax) * 100) / 100;
      const fxRate = fxRateOverride ?? existingRate;
      const functionalTotal = Math.round(total * fxRate * 100) / 100;
      computed = { subtotal, tax, total, functionalTotal, rate };
    }

    await tx`
      UPDATE customer_invoices
         SET notes = COALESCE(${notes ?? null}, notes),
             internal_notes = COALESCE(${internalNotes ?? null}, internal_notes),
             due_date = COALESCE(${dueDate ?? null}, due_date),
             customer_id = COALESCE(${clientId ?? null}::UUID, customer_id),
             client_id = COALESCE(${clientId ?? null}::UUID, client_id),
             invoice_date = COALESCE(${invoiceDate ?? null}, invoice_date),
             billing_period_start = COALESCE(${billingPeriodStart ?? null}, billing_period_start),
             billing_period_end = COALESCE(${billingPeriodEnd ?? null}, billing_period_end),
             tax_rate = COALESCE(${computed?.rate ?? null}, tax_rate),
             subtotal = COALESCE(${computed?.subtotal ?? null}, subtotal),
             tax_amount = COALESCE(${computed?.tax ?? null}, tax_amount),
             total_amount = COALESCE(${computed?.total ?? null}, total_amount),
             functional_total = COALESCE(${computed?.functionalTotal ?? null}, functional_total),
             currency_code = COALESCE(${fxCode}, currency_code),
             exchange_rate = COALESCE(${fxRateOverride}, exchange_rate),
             updated_at = NOW()
       WHERE id = ${id}::UUID AND company_id = ${companyId} AND status = 'draft'
    `;

    if (items && computed) {
      // Tenant ownership is already enforced by the FOR UPDATE select above,
      // so a plain delete by invoice_id is sufficient here.
      await tx`DELETE FROM customer_invoice_items WHERE invoice_id = ${id}::UUID`;
      // Preserve the invoice's existing currency when the caller did not
      // re-send `currencyCode`. Falling back to ZAR would silently corrupt
      // line-item currency on FX invoices.
      const existingCurrency = String(ownedRows[0]!.currency_code ?? 'ZAR');
      const lineCurrency = fxCode || existingCurrency;
      for (const [i, it] of items.entries()) {
        const qty = it.quantity;
        const lineAmount = Math.round(qty * it.unitPrice * (1 - ((it.discount ?? 0) / 100)) * 100) / 100;
        const coding = codings[i]!;
        await tx`
          INSERT INTO customer_invoice_items (
            invoice_id, description, unit_price, quantity, amount, tax_rate, currency_code,
            gl_account_id, project_id, cost_center_id
          ) VALUES (
            ${id}::UUID, ${it.description}, ${it.unitPrice},
            ${qty}, ${lineAmount}, ${it.taxRate ?? computed.rate}, ${lineCurrency},
            ${coding.glAccountId}::UUID, ${coding.projectId}::UUID, ${coding.costCenterId}::UUID
          )
        `;
      }
    }

    // R-035 PR4: the editor becomes an author of the content when — and only
    // when — the edit moved the approval digest.
    await tx`
      UPDATE customer_invoices
         SET content_authors = approval_add_author(content_authors, ${editedBy}::UUID), content_edited_at = NOW()
       WHERE id = ${id}::UUID AND company_id = ${companyId}
         AND approval_document_digest(company_id, 'customer_invoice', id)
             IS DISTINCT FROM ${ownedRows[0]!.digest ?? null}::TEXT
    `;

    return { kind: 'ok' as const };
  });
}
