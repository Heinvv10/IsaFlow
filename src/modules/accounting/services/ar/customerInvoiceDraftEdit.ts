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
 *
 * The lines carry CC1 / CC2 / BU (migration 870), which the approval digest
 * covers (873). Replacing the lines used to drop them; a line now keeps what it
 * leaves out, or the edit is refused when that is ambiguous (`bad_dimensions`).
 */
import type { z } from 'zod';
import { withTransaction } from '@/lib/neon';
import { checkDocumentCurrency, DocumentCurrencyError, loadCompanyCurrency } from '../shared/documentCurrency';
import type { PutBodySchema } from '@/lib/schemas/customerInvoiceDetail';
import { customerFnoId, deriveRevenueDimensions } from '../gl/dimensions/dimensionDerivation';
import { keepStoredDimensions } from '../gl/dimensions/dimensionKeepStored';
import { assertDocumentDimensions } from '../gl/dimensions/dimensionPolicy';
import { isDimensionRefusal, type DimensionIds } from '../gl/dimensions/dimensionTypes';

type Row = Record<string, unknown>;

export type CustomerInvoiceDraftEdit = z.infer<typeof PutBodySchema>;

export type CustomerInvoiceDraftEditResult =
  | { kind: 'ok' } | { kind: 'not_found' } | { kind: 'not_draft' } | { kind: 'bad_client' } | { kind: 'rate_required' }
  | { kind: 'currency_refused'; message: string }
  | { kind: 'bad_dimensions'; message: string };

export async function editDraftCustomerInvoice(
  companyId: string, editedBy: string, edit: CustomerInvoiceDraftEdit,
): Promise<CustomerInvoiceDraftEditResult> {
  const {
    id, notes, internalNotes, dueDate,
    clientId, invoiceDate, billingPeriodStart, billingPeriodEnd,
    taxRate, currencyCode, exchangeRate, items,
  } = edit;
  // Blank is "no change", as it is "the functional currency" on create.
  const fxCode = currencyCode?.trim().toUpperCase() || null;
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
      SELECT status, currency_code, exchange_rate, tax_rate, COALESCE(client_id, customer_id) AS customer_id,
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
    // FX PR0: the currency and rate EVERY edit leaves the invoice with — the
    // functional currency at exactly 1, or a foreign one only once enabled. A
    // legacy foreign draft is refused here (400) whatever the edit, rather than
    // by the database gate on the way out.
    let nextCode: string | null = null;
    const company = await loadCompanyCurrency(companyId, tx);
    try {
      const checked = checkDocumentCurrency(company,
        fxCode ?? ownedRows[0]!.currency_code, fxRateOverride ?? existingRate, 'invoice');
      if (fxCode !== null) nextCode = checked.currencyCode;
    } catch (err) {
      if (err instanceof DocumentCurrencyError) return { kind: 'currency_refused' as const, message: err.message };
      throw err;
    }
    // A currency change relabels every figure the invoice holds. A legacy foreign
    // draft (switch off) may not change at all: the edit page re-sends its lines
    // unchanged, so "lines included" proves nothing — its USD amounts would post
    // as rands. Otherwise the lines must come with the change.
    const storedCode = String(ownedRows[0]!.currency_code ?? '').trim().toUpperCase() || company.functionalCurrency;
    if (nextCode !== null && nextCode !== storedCode) {
      if (storedCode !== company.functionalCurrency && !company.fxDocumentsEnabled) {
        return { kind: 'currency_refused' as const, message: `This ${storedCode} draft cannot be changed to ${nextCode}: `
          + `cancel it and create the invoice again in ${nextCode}, with its amounts in ${nextCode}.` };
      }
      if (!items) {
        return { kind: 'currency_refused' as const, message: `Changing this invoice from ${storedCode} to ${nextCode} `
          + `needs its lines re-entered in ${nextCode} — changing only the currency would book the ${storedCode} figures as ${nextCode}.` };
      }
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

    // CC1 / CC2 / BU (migration 870), as create treats them: a replacement line
    // keeps what it leaves out (dimensionKeepStored), CC1 is derived from CC2
    // and the customer's FNO applied, every id validated — all before the
    // first write. On a customer change a CC1 that is the OLD customer's FNO
    // was derived from that customer, so it is re-derived for the new one
    // (lines replaced or not); only another explicit CC1 can conflict.
    let lines: (Omit<NonNullable<typeof items>[number], keyof DimensionIds> & DimensionIds)[] | null = null;
    let restamped: { id: string; cc1Id: string | null }[] = [];
    if (items || clientId !== undefined) {
      const stored = (await tx`
        SELECT cii.id, cii.cc1_id, cii.cc2_id, cii.bu_id
          FROM customer_invoice_items cii JOIN customer_invoices ci ON ci.id = cii.invoice_id
         WHERE cii.invoice_id = ${id}::UUID AND ci.company_id = ${companyId}
      `) as Row[];
      const oldCustomer = String(ownedRows[0]!.customer_id);
      const customerId = clientId ?? oldCustomer;
      const customerChanged = customerId.toLowerCase() !== oldCustomer.toLowerCase();
      const oldFno = customerChanged ? (await customerFnoId(companyId, oldCustomer))?.toLowerCase() ?? null : null;
      const rederive = <T extends DimensionIds>(line: T): T => {
        if (!oldFno || line.cc1Id?.toLowerCase() !== oldFno) return line;
        const { cc1Id: _fromOldCustomer, ...rest } = line;
        return rest as T;
      };
      try {
        if (items) {
          lines = await deriveRevenueDimensions(companyId, customerId, keepStoredDimensions(items, stored).map(rederive));
          await assertDocumentDimensions(companyId, lines);
        } else if (customerChanged) {
          const derived = await deriveRevenueDimensions(companyId, customerId, stored.map((r) => rederive<DimensionIds>({
            ...(r.cc1_id ? { cc1Id: String(r.cc1_id) } : {}), ...(r.cc2_id ? { cc2Id: String(r.cc2_id) } : {}),
            ...(r.bu_id ? { buId: String(r.bu_id) } : {}),
          })));
          restamped = derived.map((d, i) => ({ id: String(stored[i]!.id), cc1Id: d.cc1Id ?? null }));
        }
      } catch (err) {
        if (isDimensionRefusal(err)) return { kind: 'bad_dimensions' as const, message: err.message };
        throw err;
      }
    }

    let computed: { subtotal: number; tax: number; total: number; rate: number } | null = null;
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
      computed = { subtotal, tax, total, rate };
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
             functional_total = CASE WHEN ${computed !== null || fxRateOverride !== null}::BOOLEAN
               THEN public.fx_functional(COALESCE(${computed?.total ?? null}::NUMERIC(15,2), total_amount),
                                         COALESCE(${fxRateOverride}::NUMERIC(18,6), NULLIF(exchange_rate, 0), 1))
               ELSE functional_total END,
             currency_code = COALESCE(${nextCode}, currency_code),
             exchange_rate = COALESCE(${fxRateOverride}, exchange_rate),
             updated_at = NOW()
       WHERE id = ${id}::UUID AND company_id = ${companyId} AND status = 'draft'
    `;

    if (lines && computed) {
      // Tenant ownership is already enforced by the FOR UPDATE select above,
      // so a plain delete by invoice_id is sufficient here.
      await tx`DELETE FROM customer_invoice_items WHERE invoice_id = ${id}::UUID`;
      // Preserve the invoice's existing currency when the caller did not
      // re-send `currencyCode`. Falling back to ZAR would silently corrupt
      // line-item currency on FX invoices.
      const existingCurrency = String(ownedRows[0]!.currency_code ?? 'ZAR');
      const lineCurrency = nextCode ?? existingCurrency;
      for (const it of lines) {
        const qty = it.quantity;
        const lineAmount = Math.round(qty * it.unitPrice * (1 - ((it.discount ?? 0) / 100)) * 100) / 100;
        await tx`
          INSERT INTO customer_invoice_items (
            invoice_id, description, unit_price, quantity, amount, tax_rate, currency_code,
            cc1_id, cc2_id, bu_id
          ) VALUES (
            ${id}::UUID, ${it.description}, ${it.unitPrice},
            ${qty}, ${lineAmount}, ${it.taxRate ?? computed.rate}, ${lineCurrency},
            ${it.cc1Id ?? null}::UUID, ${it.cc2Id ?? null}::UUID, ${it.buId ?? null}::UUID
          )
        `;
      }
    }

    // The lines stay; the new customer's FNO replaces the one the old customer gave them.
    for (const r of restamped) {
      await tx`UPDATE customer_invoice_items SET cc1_id = ${r.cc1Id}::UUID WHERE id = ${r.id}::UUID AND invoice_id = ${id}::UUID`;
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
