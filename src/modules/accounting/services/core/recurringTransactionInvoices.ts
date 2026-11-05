/**
 * The AR and AP halves of `executeRecurring`.
 *
 * Split out of recurringTransactionService only because that file reached the
 * 300-line cap once the template row-lock and the line-item write went in; the
 * two functions are the branches that used to sit inline, unchanged in intent.
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { dueDateForContact } from './paymentTermsResolver';
import type { DbRow } from '@/types/db';
import { computeFingerprint } from '../capture/captureDeduplicationService';
import { assertCustomerInCompany, assertSupplierInCompany } from './contactDirectoryService';
import { insertWithReservedNumber } from './documentNumberRetry';
import { billLineAccountRefusal } from '../ap/billLineAccountGuard';
import { RecurringTemplateLineAccountError } from './recurringTransactionErrors';
import { readCodingId } from '../ar/invoiceLineCoding';
import { invoiceLineCodingRefusal } from '../ar/invoiceLineCodingGuard';
import { headerTotals, normaliseLines } from './recurringTemplateLines';
import type { RecurringTemplate } from './recurringTransactionService';
import { assertNonNegativeDocumentTotal } from '../shared/documentTotalSign';
import { evaluateApprovalGate } from '../gl/approvalGate';
import { raiseUnattendedApproval } from '../gl/approvalUnattended';
import { stampUpstreamAuthors } from '../ar/customerInvoiceUpstreamAuthors';
import { revenueLineDefaults } from '../gl/dimensions/dimensionDerivation';
import { recordBudgetRefusal } from '../budgets/budgetCheck';
import { BudgetExceededError } from '../budgets/budgetCheckTypes';
import { resolveBillLineDimensions } from '../gl/dimensions/supplierDimensionDefaults';
import { DimensionRefusal } from '../gl/dimensions/dimensionTypes';
import { UUID_RE } from '@/lib/validation';

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
  // R-119: templateData is opaque JSON, and the create-time qty/price guard
  // does not re-run here. Refused before the number is reserved.
  assertNonNegativeDocumentTotal(totals.totalAmount, `Recurring template ${template.id}`, 'customer');
  // The template's JSON names revenue accounts nothing re-checked, tenant
  // included — and since migration 874 posting credits them. The AP arm's
  // check, with the invoice line's rules; before the number is reserved.
  const accountIds = lines.map((l) => readCodingId(l.glAccountId));
  const accountRefusal = accountIds.includes(undefined)
    ? 'a line names an account id that is not a UUID.'
    : await invoiceLineCodingRefusal(companyId, accountIds.map((glAccountId) => (
      { glAccountId: glAccountId ?? null, projectId: null })));
  if (accountRefusal) {
    throw new RecurringTemplateLineAccountError(template.id, `Recurring template "${template.name}": ${accountRefusal}`);
  }
  // The customer's FNO is stored on each line, so it is what posts and what an approval covers (dimensionStoredPosting).
  const dims = await revenueLineDefaults(companyId, clientId);
  // The customer's terms, else the company default (migration 960), from the date this run writes.
  const invoiceDate = fmtDate(new Date());
  const dueDate = await dueDateForContact(companyId, 'customer', String(clientId), invoiceDate);
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
          ${invoiceDate}::DATE,
          ${dueDate}::DATE,
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
            invoice_id, description, quantity, unit_price, tax_rate, amount, gl_account_id, cc1_id
          ) VALUES (
            ${id}::UUID, ${line.description}, ${line.quantity}, ${line.unitPrice},
            ${line.taxRate}, ${line.lineTotal}, ${line.glAccountId}, ${dims.cc1Id ?? null}::UUID
          )
        `;
      }
      return id;
    });
  // R-035 PR4 review F1: the template's authors are the invoice's, before any
  // request is raised. (Not done for bills below: see migration 865.)
  await stampUpstreamAuthors(companyId, entityId, { kind: 'recurring_transaction_template', id: template.id });

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
    // R-035 PR4: an invoice an enforced approval rule governs is left a draft,
    // with the request raised as the runner — not refused after the INSERT.
    if (await evaluateApprovalGate(companyId, 'customer_invoice', entityId)) {
      await raiseUnattendedApproval(companyId, 'customer_invoice', entityId, userId);
      return { entityId, posted: false };
    }
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
): Promise<{ entityId: string; posted: boolean; warnings?: string[] }> {
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
  // R-068: the template row is company-scoped, the id inside its JSON is not.
  await assertSupplierInCompany(companyId, supplierId);
  const named = normaliseLines(data);
  // The template's JSON names accounts nothing re-checks, tenant included.
  const accountRefusal = await billLineAccountRefusal(companyId, named.map((l) => l.glAccountId));
  if (accountRefusal) {
    throw new RecurringTemplateLineAccountError(template.id, `Recurring template "${template.name}": ${accountRefusal}`);
  }
  // Budgets P5-2b (breaker REPRO 1): the line's dimensions as every bill writer resolves them — the template's own,
  // else the supplier's defaults (migration 890), CC1 derived from a CC2, tenant / slot / active checked. Reads only.
  const badDim = named.findIndex((l) => [l.cc1Id, l.cc2Id, l.buId].some((v) => v !== undefined && !UUID_RE.test(v)));
  if (badDim >= 0) {
    throw new RecurringTemplateLineAccountError(template.id,
      `Recurring template "${template.name}": line ${badDim + 1} names a cost centre or business unit that is not an id.`);
  }
  let lines: typeof named;
  try {
    lines = await resolveBillLineDimensions(companyId, supplierId, named);
  } catch (err) {
    if (!(err instanceof DimensionRefusal)) throw err;
    throw new RecurringTemplateLineAccountError(template.id, `Recurring template "${template.name}": ${err.message}`);
  }
  // Asserted BEFORE the first write of the run, so the route may answer 4xx.
  const totals = headerTotals(template.id, data, lines);
  // R-119, AP side of the same opaque templateData.
  assertNonNegativeDocumentTotal(totals.totalAmount, `Recurring template ${template.id}`, 'supplier');
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

  // The supplier's terms, else the company default (migration 960), from the date this run writes.
  const invoiceDate = fmtDate(new Date());
  const dueDate = await dueDateForContact(companyId, 'supplier', String(supplierId), invoiceDate);
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
          ${invoiceDate}::DATE,
          ${dueDate}::DATE,
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
            tax_amount, line_total, gl_account_id, cc1_id, cc2_id, bu_id
          ) VALUES (
            ${id}::UUID, ${line.description}, ${line.quantity}, ${line.unitPrice},
            ${line.taxRate}, ${line.taxAmount}, ${line.lineTotal}, ${line.glAccountId},
            ${line.cc1Id ?? null}::UUID, ${line.cc2Id ?? null}::UUID, ${line.buId ?? null}::UUID
          )
        `;
      }
      return id;
    });

  if (template.autoPost) {
    // Same as the customer side above: 'posted' is not a value
    // supplier_invoices_status_check permits (draft, pending_approval,
    // approved, partially_paid, paid, disputed, cancelled), so every auto-post
    // AP template raised 23514 on every run. approveSupplierInvoice is the path
    // that both sets the status and posts the Expense / VAT input / AP journal.
    // R-035 (A6): a bill an enforced approval rule governs is left a draft,
    // with the request raised as the runner — not refused after the INSERT.
    if (await evaluateApprovalGate(companyId, 'supplier_invoice', entityId)) {
      await raiseUnattendedApproval(companyId, 'supplier_invoice', entityId, userId);
      return { entityId, posted: false };
    }
    const { approveSupplierInvoice } = await import('../ap/supplierInvoiceWorkflowService');
    // Budgets P5-2: unattended (channel system). The template row, its accounts and the document number
    // are already locked, so the company budget lock cannot come first: lock-free (`none`), a named
    // residual race in block mode (ap/.claude.md). Over budget under block, the bill is left a DRAFT
    // (as the approval gate leaves one, above), the refusal recorded and reported; the schedule advances.
    try {
      const approved = await approveSupplierInvoice(companyId, entityId, userId, { budget: { channel: 'system', lock: 'none' } });
      return { entityId, posted: true, ...(approved.budgetWarnings ? { warnings: approved.budgetWarnings } : {}) };
    } catch (err) {
      if (!(err instanceof BudgetExceededError)) throw err;
      await recordBudgetRefusal(err); // approve's savepoint rolled back; this is on the run's transaction
      return { entityId, posted: false, warnings: [`Left as a draft: ${err.message}`] };
    }
  }
  return { entityId, posted: false };
}
