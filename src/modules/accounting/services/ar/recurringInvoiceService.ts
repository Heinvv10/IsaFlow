/**
 * Recurring Invoice Service
 * Phase 1 Sage Alignment: Auto-generate customer invoices on schedule
 */

import { sql, withSavepoint } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { approveCustomerInvoice } from './customerInvoiceApprovalService';
import {
  assertAggregateAgrees,
  deriveTotals,
  parseLineItems,
  RecurringInvoiceTemplateError,
} from './recurringInvoiceTemplate';
import { lockRecurringTemplate, RecurringInvoiceLockTimeoutError } from './recurringInvoiceLock';
import { reserveNextDocumentNumber } from '../core/companySettingsService';
import type {
  RecurringInvoice,
  RecurringInvoiceCreateInput,
} from '../../types/ar.types';

type Row = DbRow;

export async function getRecurringInvoices(companyId: string, filters?: {
  status?: string;
  clientId?: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: RecurringInvoice[]; total: number }> {
  const limit = filters?.limit || 50;
  const offset = filters?.offset || 0;
  let rows: Row[];
  let countRows: Row[];

  if (filters?.clientId) {
    rows = (await sql`
      SELECT ri.*, c.name AS client_name
      FROM recurring_invoices ri LEFT JOIN customers c ON c.id = ri.client_id
      WHERE ri.company_id = ${companyId} AND ri.client_id = ${filters.clientId}::UUID
      ORDER BY ri.created_at DESC LIMIT ${limit} OFFSET ${offset}
    `) as Row[];
    countRows = (await sql`
      SELECT COUNT(*) AS cnt FROM recurring_invoices
      WHERE company_id = ${companyId} AND client_id = ${filters.clientId}::UUID
    `) as Row[];
  } else if (filters?.status) {
    rows = (await sql`
      SELECT ri.*, c.name AS client_name
      FROM recurring_invoices ri LEFT JOIN customers c ON c.id = ri.client_id
      WHERE ri.company_id = ${companyId} AND ri.status = ${filters.status}
      ORDER BY ri.created_at DESC LIMIT ${limit} OFFSET ${offset}
    `) as Row[];
    countRows = (await sql`
      SELECT COUNT(*) AS cnt FROM recurring_invoices WHERE company_id = ${companyId} AND status = ${filters.status}
    `) as Row[];
  } else {
    rows = (await sql`
      SELECT ri.*, c.name AS client_name
      FROM recurring_invoices ri LEFT JOIN customers c ON c.id = ri.client_id
      WHERE ri.company_id = ${companyId}
      ORDER BY ri.created_at DESC LIMIT ${limit} OFFSET ${offset}
    `) as Row[];
    countRows = (await sql`SELECT COUNT(*) AS cnt FROM recurring_invoices WHERE company_id = ${companyId}`) as Row[];
  }

  return { items: rows.map(mapRow), total: Number(countRows[0]?.cnt || 0) };
}

export async function createRecurringInvoice(companyId: string, 
  input: RecurringInvoiceCreateInput,
  userId: string
): Promise<RecurringInvoice> {
  const taxRate = input.taxRate ?? 15;
  // W1 family (P2.1): a template with negative lines re-mints a negative
  // approved invoice EVERY period.
  for (const li of input.lineItems || []) {
    if (!(Number(li.quantity) > 0)) {
      throw new Error(`Line "${li.description}": quantity must be positive`);
    }
    if (Number(li.unitPrice) < 0) {
      throw new Error(`Line "${li.description}": unit price cannot be negative`);
    }
  }
  const subtotal = input.lineItems.reduce(
    (s, li) => s + li.quantity * li.unitPrice, 0
  );
  const taxAmount = Math.round(subtotal * (taxRate / 100) * 100) / 100;
  const totalAmount = subtotal + taxAmount;

  const rows = (await sql`
    INSERT INTO recurring_invoices (
      company_id, template_name, client_id, project_id, frequency, next_run_date,
      end_date, description, line_items, subtotal, tax_rate, tax_amount,
      total_amount, payment_terms, created_by
    ) VALUES (
      ${companyId}, ${input.templateName}, ${input.clientId}::UUID,
      ${input.projectId || null}, ${input.frequency}, ${input.nextRunDate},
      ${input.endDate || null}, ${input.description || null},
      ${JSON.stringify(input.lineItems)}::JSONB, ${subtotal}, ${taxRate},
      ${taxAmount}, ${totalAmount}, ${input.paymentTerms || '30 days'}, ${userId}::UUID
    ) RETURNING *
  `) as Row[];

  log.info('Created recurring invoice', { id: rows[0]?.id }, 'accounting');
  return mapRow(rows[0]!);
}

export async function updateRecurringStatus(companyId: string,
  id: string,
  status: 'paused' | 'active' | 'cancelled'
): Promise<void> {
  const result = (await sql`UPDATE recurring_invoices SET status = ${status} WHERE id = ${id} AND company_id = ${companyId} RETURNING id`) as Row[];
  if (result.length === 0) throw new Error(`Recurring invoice not found: ${id}`);
  log.info('Updated recurring invoice status', { id, status }, 'accounting');
}

export { RecurringInvoiceTemplateError, RecurringInvoiceLockTimeoutError };

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
 * make `ROLLBACK TO` unwind the wrong one. Same convention as neon.ts's
 * `sp_sqltx_${n}`.
 */
let genSeq = 0;

export async function generateInvoiceFromRecurring(companyId: string, 
  id: string,
  userId: string
): Promise<string> {
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

async function runOneTemplate(companyId: string, id: string, userId: string): Promise<string> {
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

  // THE NUMBER COMES FROM THE COMPANY SEQUENCE. MAX(invoice_number)+1 was a
  // second generator for one uniqueness domain: it left
  // company_document_numbers.next_number frozen at its seed value while live
  // numbers ran ahead of it, and it padded to 5 where the sequence pads to the
  // configured width. Retry on 23505 (a clash with a legacy number) is handled
  // at the INSERT below, which is already inside this template's savepoint.
  const invoiceNumber = await reserveNextDocumentNumber(companyId, 'customer_invoice');

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

  const invoiceId = String(inv[0]!.id);

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
  await approveCustomerInvoice(companyId, invoiceId, userId);

  await sql`
    UPDATE recurring_invoices
    SET last_run_date = CURRENT_DATE, next_run_date = ${nextDate}::DATE,
        run_count = run_count + 1, status = ${newStatus}
    WHERE id = ${id} AND company_id = ${companyId}
  `;

  log.info('Generated invoice from recurring', { recurringId: id, invoiceId }, 'accounting');
  return invoiceId;
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

function mapRow(row: Row): RecurringInvoice {
  return {
    id: String(row.id),
    templateName: String(row.template_name),
    clientId: String(row.client_id),
    projectId: row.project_id ? String(row.project_id) : undefined,
    frequency: String(row.frequency) as RecurringInvoice['frequency'],
    nextRunDate: fmtDate(row.next_run_date),
    endDate: row.end_date ? fmtDate(row.end_date) : undefined,
    lastRunDate: row.last_run_date ? fmtDate(row.last_run_date) : undefined,
    runCount: Number(row.run_count),
    status: String(row.status) as RecurringInvoice['status'],
    description: row.description ? String(row.description) : undefined,
    lineItems: Array.isArray(row.line_items) ? row.line_items as RecurringInvoice['lineItems'] : JSON.parse(typeof row.line_items === 'string' ? row.line_items : '[]'),
    subtotal: Number(row.subtotal),
    taxRate: Number(row.tax_rate),
    taxAmount: Number(row.tax_amount),
    totalAmount: Number(row.total_amount),
    paymentTerms: row.payment_terms ? String(row.payment_terms) : undefined,
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    clientName: row.client_name ? String(row.client_name) : undefined,
  };
}
