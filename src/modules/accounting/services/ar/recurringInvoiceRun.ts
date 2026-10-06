/**
 * Generating a customer invoice from a recurring template — the run behind
 * recurring-invoices-run (one template, or every one due) and the 'generate'
 * action of recurring-invoices-action. Split from recurringInvoiceService.ts,
 * which re-exports it, for the 300-line cap.
 *
 * R-035 PR4: a run is unattended — nobody decides at the moment it fires — so
 * an invoice an enforced approval rule governs is not refused. It is left the
 * DRAFT the run minted, the approval request is raised as the person who ran
 * it, the schedule still advances, and the result says the invoice is held
 * for approval. Refusing instead rolled the invoice back with the schedule,
 * so the template stalled on every later run too.
 */

import { sql, withSavepoint } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { approveCustomerInvoice } from './customerInvoiceApprovalService';
import { assertAggregateAgrees, deriveTotals, parseLineItems } from './recurringInvoiceTemplate';
import { lockRecurringTemplate } from './recurringInvoiceLock';
import { insertWithReservedNumber } from '../core/documentNumberRetry';
import { evaluateApprovalGate } from '../gl/approvalGate';
import { raiseUnattendedApproval } from '../gl/approvalUnattended';

type Row = DbRow;

/** One template's run: the invoice it minted, and whether approval holds it as a draft. */
export interface RecurringInvoiceRun {
  invoiceId: string;
  heldForApproval: boolean;
}

/** Raised when the template is not yet due; carries the date it next runs. */
export class RecurringInvoiceNotDueError extends Error {
  readonly code = 'RECURRING_INVOICE_NOT_DUE';
  constructor(recurringId: string, nextRunDate: string) {
    super(
      `Recurring invoice ${recurringId} is not due until ${nextRunDate} — running it now would `
      + 'post a second GL journal for a period already invoiced. To bill early, move the '
      + 'template\'s next run date forward and run it again.',
    );
    this.name = 'RecurringInvoiceNotDueError';
  }
}

/**
 * Savepoint names are sequenced, never a constant: Postgres SHADOWS a
 * re-declared savepoint name, so two live subtransactions sharing one would
 * make `ROLLBACK TO` unwind the wrong one. Same convention as src/lib/neon/sql.ts's
 * `sp_sqltx_${n}`.
 */
let genSeq = 0;

/** The invoice a run minted; callers that report a held invoice use runRecurringInvoice. */
export async function generateInvoiceFromRecurring(companyId: string, id: string, userId: string): Promise<string> {
  return (await runRecurringInvoice(companyId, id, userId)).invoiceId;
}

export async function runRecurringInvoice(companyId: string,
  id: string,
  userId: string
): Promise<RecurringInvoiceRun> {
  // THE SAVEPOINT OPENS BEFORE THE LOCK, not after it. The whole request — every
  // template in a "Run All" — is one transaction on the ALS client, and the 5s
  // `lock_timeout` on the read below raises 55P03, which ABORTS that transaction.
  // Taken outside a savepoint there is nothing to unwind to: every later template
  // fails 25P02, the runner's per-item catch reports them as skips, and withAuth
  // COMMITs on the resulting 200 — a COMMIT that Postgres executes as ROLLBACK
  // without raising, so the caller is handed ids for invoices that no longer
  // exist. `assertTxUsable` cannot see this: `txUnusable` is set only when a
  // savepoint's own rollback fails. Covering the lock and the invoice-number
  // read makes the typed "retry in a moment" error mean what it says.
  const savepoint = `recurring_invoice_gen_${++genSeq}`;
  return withSavepoint(savepoint, () => runOneTemplate(companyId, id, userId));
}

async function runOneTemplate(companyId: string, id: string, userId: string): Promise<RecurringInvoiceRun> {
  // FOR UPDATE, because "is it active and due" is a check-then-act. Two
  // concurrent runs of one template used to collide only by luck, on the
  // invoice-number unique index.
  const ri = await lockRecurringTemplate(companyId, id);
  if (!ri) throw new Error('Recurring invoice not found');
  if (ri.status !== 'active') throw new Error('Recurring invoice is not active');

  // A REPEAT RUN NOW POSTS A REAL JOURNAL, so it has to be refused. Before the
  // canonical approve path was wired in, running the single-template endpoint
  // twice minted a duplicate header with no ledger effect; now it would
  // overstate revenue and VAT output by the invoice total and skip a period.
  // The first run advances next_run_date past today, so this is what makes a
  // double-click, a client retry or a re-POST a no-op.
  if (!ri.is_due) {
    throw new RecurringInvoiceNotDueError(id, fmtDate(ri.next_run_date));
  }

  const nextDate = advanceDate(String(ri.next_run_date), String(ri.frequency));
  const endDate = ri.end_date ? String(ri.end_date) : null;
  const newStatus = endDate && nextDate > endDate ? 'completed' : 'active';


  // The template's lines ARE the invoice. Minting a header with none of them
  // put a receivable in AR with no detail behind it, so refuse rather than
  // generate an empty document (and leave the schedule un-advanced).
  const lineItems = parseLineItems(id, ri.line_items);
  const taxRate = Number(ri.tax_rate ?? 0);

  // THE HEADER IS DERIVED FROM THE LINES, not copied from the stored aggregate.
  // The journal is posted from the header (postCustomerInvoiceToGL reads
  // subtotal/tax_amount/total_amount) while the lines are computed
  // independently, so trusting the aggregate would let AR and the invoice
  // detail disagree — the same divergence this fix exists to close, one level
  // down. The stored aggregate is still checked, so a template whose totals
  // have drifted is refused rather than silently re-priced.
  const totals = deriveTotals(lineItems, taxRate);
  assertAggregateAgrees(id, totals, ri, lineItems.length);

  // THE NUMBER COMES FROM THE COMPANY SEQUENCE. MAX(invoice_number)+1 was a
  // second generator for one uniqueness domain: it left
  // company_document_numbers.next_number frozen at its seed value while live
  // numbers ran ahead of it, and it padded to 5 where the sequence pads to the
  // configured width. The helper reserves, and retries past a number some
  // legacy row already holds under its own savepoint — without that, a single
  // such row stalls this template on every future run.
  const invoiceId = await insertWithReservedNumber(
    companyId, 'customer_invoice', 'rec_inv_', 'uq_customer_invoices_company_number', async (invoiceNumber) => {
      const inv = (await sql`
        INSERT INTO customer_invoices (
          company_id, invoice_number, client_id, customer_id, project_id,
          invoice_date, due_date, subtotal, tax_rate, tax_amount, total_amount,
          status, notes, created_by
        ) VALUES (
          ${companyId}::UUID, ${invoiceNumber}, ${ri.client_id}::UUID, ${ri.client_id}::UUID,
          ${ri.project_id || null},
          CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',
          ${totals.subtotal}, ${taxRate}, ${totals.taxAmount}, ${totals.totalAmount},
          'draft', ${ri.description || ri.template_name}, ${userId}::UUID
        ) RETURNING id
      `) as Row[];
      return String(inv[0]!.id);
    });

  for (const li of lineItems) {
    await sql`
      INSERT INTO customer_invoice_items (
        invoice_id, description, unit_price, quantity, amount, tax_rate
      ) VALUES (
        ${invoiceId}::UUID, ${li.description}, ${li.unitPrice},
        ${li.quantity}, ${li.amount}, ${taxRate}
      )
    `;
  }

  // Approve through the canonical path so the GL journal (DR AR / CR Revenue /
  // CR VAT Output) is posted. Inserting 'approved' directly left the invoice in
  // AR with gl_journal_entry_id NULL — AR and the GL out of agreement by the
  // invoice total. A failure here propagates and rolls the header back with it,
  // and the schedule below is advanced only once the invoice really exists.
  // R-035 PR4: unless an enforced rule governs it — then it stays a draft, the
  // request is raised as the runner (nothing is raised under Login-as; the
  // invoice page then still offers Submit), and the schedule advances below.
  const heldForApproval = (await evaluateApprovalGate(companyId, 'customer_invoice', invoiceId)) !== null;
  if (heldForApproval) {
    await raiseUnattendedApproval(companyId, 'customer_invoice', invoiceId, userId);
  } else {
    await approveCustomerInvoice(companyId, invoiceId, userId);
  }

  await sql`
    UPDATE recurring_invoices
    SET last_run_date = CURRENT_DATE, next_run_date = ${nextDate}::DATE,
        run_count = run_count + 1, status = ${newStatus}
    WHERE id = ${id} AND company_id = ${companyId}
  `;

  log.info('Generated invoice from recurring', { recurringId: id, invoiceId, heldForApproval }, 'accounting');
  return { invoiceId, heldForApproval };
}

function advanceDate(dateStr: string, frequency: string): string {
  const d = new Date(dateStr);
  switch (frequency) {
    case 'weekly': d.setDate(d.getDate() + 7); break;
    case 'monthly': d.setMonth(d.getMonth() + 1); break;
    case 'quarterly': d.setMonth(d.getMonth() + 3); break;
    case 'annually': d.setFullYear(d.getFullYear() + 1); break;
  }
  return d.toISOString().split('T')[0]!;
}
