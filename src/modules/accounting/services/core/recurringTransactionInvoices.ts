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
import { assertCustomerInCompany } from './contactDirectoryService';
import { insertWithReservedNumber } from './documentNumberRetry';
import { headerTotals, normaliseLines } from './recurringTemplateLines';
import type { RecurringTemplate } from './recurringTransactionService';

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
  // R-067: templateData is opaque JSON supplied when the template was saved,
  // so the id is caller-supplied however company-scoped the template row is.
  // Before insertWithReservedNumber, whose reservation is the first write.
  await assertCustomerInCompany(companyId, clientId);
  const lines = normaliseLines(data);
  // Asserted BEFORE the first write of the run, so the route may answer 4xx.
  const totals = headerTotals(template.id, data, lines);
  const entityId = await insertWithReservedNumber(
    companyId, 'customer_invoice', 'rec_txn_inv_', 'uq_customer_invoices_company_number', async (invoiceNumber) => {
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
          ${totals.subtotal},
          ${totals.taxAmount},
          ${totals.totalAmount},
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
    // POST THROUGH THE CANONICAL APPROVE PATH, not with a hand-rolled UPDATE.
    // The old statement set status = 'posted', which is not a value
    // customer_invoices_status_check permits (draft, pending_approval,
    // approved, sent, paid, partially_paid, overdue, cancelled) — so EVERY
    // auto-post template raised 23514 and the whole run rolled back, on every
    // run, for every tenant that ticked the box. Setting the merely-legal
    // 'approved' by hand would be no better: an approved invoice sits in AR,
    // and approveCustomerInvoice is what writes the DR AR / CR Revenue / CR VAT
    // journal behind it, so a bare status change would leave AR and the GL
    // apart by the invoice total. Delegating makes auto_post mean what it says.
    const { approveCustomerInvoice } = await import('../ar/customerInvoiceApprovalService');
    await approveCustomerInvoice(companyId, entityId, userId);
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
  const lines = normaliseLines(data);
  // Asserted BEFORE the first write of the run, so the route may answer 4xx.
  const totals = headerTotals(template.id, data, lines);
  const total = totals.totalAmount;

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
    companyId, 'supplier_invoice', 'rec_txn_bill_', 'uq_supplier_invoices_supplier_number', async (invoiceNumber) => {
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
          ${totals.subtotal},
          ${totals.taxAmount},
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
    // Same as the customer side above: 'posted' is not a value
    // supplier_invoices_status_check permits (draft, pending_approval,
    // approved, partially_paid, paid, disputed, cancelled), so every auto-post
    // AP template raised 23514 on every run. approveSupplierInvoice is the path
    // that both sets the status and posts the Expense / VAT input / AP journal.
    const { approveSupplierInvoice } = await import('../ap/supplierInvoiceWorkflowService');
    await approveSupplierInvoice(companyId, entityId, userId);
    posted = true;
  }
  return { entityId, posted };
}
