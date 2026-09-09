/**
 * The AR and AP halves of `executeRecurring`.
 *
 * Split out of recurringTransactionService only because that file reached the
 * 300-line cap once the template row-lock and the line-item write went in; the
 * two functions are the branches that used to sit inline, unchanged in intent.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';
import { computeFingerprint } from '../capture/captureDeduplicationService';
import { insertWithReservedNumber } from './documentNumberRetry';
import type { RecurringTemplate } from './recurringTransactionService';

interface TemplateLine {
  description?: unknown;
  quantity?: unknown;
  unitPrice?: unknown;
  taxRate?: unknown;
  lineTotal?: unknown;
  amount?: unknown;
  accountId?: unknown;
  glAccountId?: unknown;
}

interface NormalisedLine {
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  lineTotal: number;
  taxAmount: number;
  glAccountId: string | null;
}

/**
 * The template's `lines` array, normalised. Absent or empty is allowed: the
 * templates in production predate the field and carry only the aggregate, and
 * refusing those would stop every existing recurring run. When lines ARE given
 * — the shape the create modal documents — they are written, so the document
 * has detail behind it rather than a bare header.
 */
function normaliseLines(data: Record<string, unknown>): NormalisedLine[] {
  if (!Array.isArray(data.lines)) return [];
  return (data.lines as TemplateLine[]).map((l) => {
    const quantity = Number(l.quantity ?? 1);
    const unitPrice = Number(l.unitPrice ?? 0);
    const taxRate = Number(l.taxRate ?? 0);
    const lineTotal = Number(l.lineTotal ?? l.amount ?? quantity * unitPrice);
    const account = String(l.accountId ?? l.glAccountId ?? '');
    return {
      description: String(l.description ?? ''),
      quantity,
      unitPrice,
      taxRate,
      lineTotal,
      // taxRate is a percentage, so tax is lineTotal * rate / 100; the divide
      // by 100 after rounding the product is that, rounded to two decimals.
      taxAmount: Math.round(lineTotal * taxRate) / 100,
      glAccountId: account || null,
    };
  });
}

export async function mintRecurringCustomerInvoice(
  companyId: string,
  template: RecurringTemplate,
  userId: string,
): Promise<{ entityId: string; posted: boolean }> {
  // BL-56: populate invoice_number, customer_id, created_by (all NOT-NULL)
  const data = template.templateData;
  // THE NUMBER COMES FROM THE COMPANY SEQUENCE. It used to be
  // `RINV-<slug>-<YYYYMM>` — the period token is the calendar month, so a
  // daily or weekly template minted the SAME number on every run after the
  // first and died on uq_customer_invoices_company_number (23505). The type
  // is 'customer_invoice', the SAME sequence every other writer of this
  // table uses: a second type would leave the counter in company settings
  // failing to account for invoices this runner created.
  const clientId = data.clientId ? String(data.clientId) : null;
  const lines = normaliseLines(data);
  const entityId = await insertWithReservedNumber(
    companyId, 'customer_invoice', 'rec_txn_inv_', async (invoiceNumber) => {
      const ciRows = (await sql`
        INSERT INTO customer_invoices (
          company_id, invoice_number, client_id, customer_id, invoice_date, due_date,
          notes, subtotal, tax_amount, total_amount, status, created_by
        ) VALUES (
          ${companyId}::UUID,
          ${invoiceNumber},
          ${clientId},
          ${clientId},
          CURRENT_DATE,
          CURRENT_DATE::DATE + INTERVAL '30 days',
          ${String(data.notes || template.name)},
          ${Number(data.subtotal || 0)},
          ${Number(data.vatAmount || 0)},
          ${Number(data.totalAmount || 0)},
          'draft',
          ${userId}::UUID
        ) RETURNING id
      `) as DbRow[];
      const id = String(ciRows[0]?.id);
      // Written INSIDE the savepointed attempt: a 23505 on the number must roll
      // the lines back with the header they belong to, not orphan them.
      for (const line of lines) {
        await sql`
          INSERT INTO customer_invoice_items (
            invoice_id, description, quantity, unit_price, tax_rate, amount, gl_account_id
          ) VALUES (
            ${id}::UUID, ${line.description}, ${line.quantity}, ${line.unitPrice},
            ${line.taxRate}, ${line.lineTotal}, ${line.glAccountId}
          )
        `;
      }
      return id;
    });

  let posted = false;
  if (template.autoPost) {
    const postResult = (await sql`UPDATE customer_invoices SET status = 'posted' WHERE id = ${entityId}::UUID AND company_id = ${companyId}::UUID RETURNING id`) as DbRow[];
    if (postResult.length === 0) throw new Error(`Customer invoice not found for auto-post: ${entityId}`);
    posted = true;
  }
  return { entityId, posted };
}

export async function mintRecurringSupplierInvoice(
  companyId: string,
  template: RecurringTemplate,
  userId: string,
): Promise<{ entityId: string; posted: boolean }> {
  // BL-57: populate invoice_number, created_by (NOT-NULL)
  const data = template.templateData;
  // Same month-constant number as the customer side above, but supplier
  // invoices had NO unique index, so instead of failing the AP template
  // minted an identical bill — same number, same duplicate_fingerprint —
  // on every run, inflating payables and input VAT. Migration 646 adds
  // uq_supplier_invoices_supplier_number, and the number now comes from the
  // company sequence. It therefore RETRIES like the customer side: the
  // number is one this system chose, so a clash means only that some bill
  // already holds SIV0000042, not that this bill is already captured. Without
  // the retry one such bill wedged that company's AP templates permanently,
  // because the failed reservation rolls back with the request and the next
  // run reserves the very same number again.
  const supplierId = String(data.supplierId || '');
  const total = Number(data.totalAmount || 0);
  const lines = normaliseLines(data);

  // Fetch supplier vat_number for fingerprint
  let vatNumber: string | null = null;
  if (supplierId) {
    const [supRow] = (await sql`
      SELECT vat_number FROM suppliers
      WHERE id = ${supplierId}::UUID AND company_id = ${companyId}::UUID
    `) as DbRow[];
    vatNumber = supRow?.vat_number ?? null;
  }

  const entityId = await insertWithReservedNumber(
    companyId, 'supplier_invoice', 'rec_txn_bill_', async (invoiceNumber) => {
      // The fingerprint carries the number, so it is rebuilt per attempt.
      const fingerprint = computeFingerprint(vatNumber, invoiceNumber, total);
      const siRows = (await sql`
        INSERT INTO supplier_invoices (
          company_id, invoice_number, supplier_id, invoice_date, due_date,
          reference, notes, subtotal, tax_amount, total_amount, status, created_by,
          duplicate_fingerprint
        ) VALUES (
          ${companyId}::UUID,
          ${invoiceNumber},
          ${supplierId},
          CURRENT_DATE,
          CURRENT_DATE::DATE + INTERVAL '30 days',
          ${String(data.reference || 'AUTO-REC')},
          ${String(data.notes || data.description || template.name)},
          ${Number(data.subtotal || 0)},
          ${Number(data.vatAmount || 0)},
          ${total},
          'draft',
          ${userId}::UUID,
          ${fingerprint}
        ) RETURNING id
      `) as DbRow[];
      const id = String(siRows[0]?.id);
      for (const line of lines) {
        await sql`
          INSERT INTO supplier_invoice_items (
            supplier_invoice_id, description, quantity, unit_price, tax_rate,
            tax_amount, line_total, gl_account_id
          ) VALUES (
            ${id}::UUID, ${line.description}, ${line.quantity}, ${line.unitPrice},
            ${line.taxRate}, ${line.taxAmount}, ${line.lineTotal}, ${line.glAccountId}
          )
        `;
      }
      return id;
    });

  let posted = false;
  if (template.autoPost) {
    const postResult = (await sql`UPDATE supplier_invoices SET status = 'posted' WHERE id = ${entityId}::UUID AND company_id = ${companyId}::UUID RETURNING id`) as DbRow[];
    if (postResult.length === 0) throw new Error(`Supplier invoice not found for auto-post: ${entityId}`);
    posted = true;
  }
  return { entityId, posted };
}
