/**
 * Recurring Invoice Service
 * Phase 1 Sage Alignment: Auto-generate customer invoices on schedule
 */

import { sql, withSavepoint } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { approveCustomerInvoice } from './customerInvoiceApprovalService';
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

export async function generateInvoiceFromRecurring(companyId: string, 
  id: string,
  userId: string
): Promise<string> {
  const rows = (await sql`SELECT * FROM recurring_invoices WHERE id = ${id} AND company_id = ${companyId}`) as Row[];
  if (!rows[0]) throw new Error('Recurring invoice not found');
  const ri = rows[0];
  if (ri.status !== 'active') throw new Error('Recurring invoice is not active');

  const nextDate = advanceDate(String(ri.next_run_date), String(ri.frequency));
  const endDate = ri.end_date ? String(ri.end_date) : null;
  const newStatus = endDate && nextDate > endDate ? 'completed' : 'active';

  // Generate next invoice number
  const numRows = (await sql`
    SELECT MAX(CAST(SUBSTRING(invoice_number FROM '[0-9]+$') AS INTEGER)) AS max_num
    FROM customer_invoices WHERE company_id = ${companyId} AND invoice_number LIKE 'INV-%'
  `) as Row[];
  const nextNum = (Number(numRows[0]?.max_num) || 0) + 1;
  const invoiceNumber = `INV-${String(nextNum).padStart(5, '0')}`;

  // The template's lines ARE the invoice. Minting a header with none of them
  // put a receivable in AR with no detail behind it, so refuse rather than
  // generate an empty document (and leave the schedule un-advanced).
  const lineItems = parseLineItems(ri.line_items);
  if (lineItems.length === 0) {
    throw new Error(`Recurring invoice ${id} has no line items — nothing to generate`);
  }
  const taxRate = Number(ri.tax_rate ?? 0);

  // ONE SAVEPOINT AROUND HEADER + LINES + APPROVE. The batch runner
  // (recurring-invoices-run.ts:89) catches per template and carries on, so
  // without this a template that fails at approval leaves its half-built
  // invoice inside the request transaction — which the route then COMMITs on
  // its 200 — and the caught Postgres error would poison every later item with
  // 25P02. Rolled back here, the catch means what it says.
  const invoiceId = await withSavepoint('recurring_invoice_gen', async () => {
    const inv = (await sql`
      INSERT INTO customer_invoices (
        company_id, invoice_number, client_id, customer_id, project_id,
        invoice_date, due_date, subtotal, tax_rate, tax_amount, total_amount,
        status, notes, created_by
      ) VALUES (
        ${companyId}::UUID, ${invoiceNumber}, ${ri.client_id}::UUID, ${ri.client_id}::UUID,
        ${ri.project_id || null},
        CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',
        ${Number(ri.subtotal)}, ${taxRate}, ${Number(ri.tax_amount)}, ${Number(ri.total_amount)},
        'draft', ${ri.description || ri.template_name}, ${userId}::UUID
      ) RETURNING id
    `) as Row[];

    const newInvoiceId = String(inv[0]!.id);

    for (const li of lineItems) {
      const qty = Number(li.quantity) || 1;
      const lineAmount = Math.round(qty * Number(li.unitPrice) * 100) / 100;
      await sql`
        INSERT INTO customer_invoice_items (
          invoice_id, description, unit_price, quantity, amount, tax_rate
        ) VALUES (
          ${newInvoiceId}::UUID, ${li.description}, ${Number(li.unitPrice)},
          ${qty}, ${lineAmount}, ${taxRate}
        )
      `;
    }

    // Approve through the canonical path so the GL journal (DR AR / CR Revenue /
    // CR VAT Output) is posted. Inserting 'approved' directly left the invoice in
    // AR with gl_journal_entry_id NULL — AR and the GL out of agreement by the
    // invoice total. A failure here propagates and rolls the header back with it,
    // and the schedule below is advanced only once the invoice really exists.
    await approveCustomerInvoice(companyId, newInvoiceId, userId);
    return newInvoiceId;
  });

  await sql`
    UPDATE recurring_invoices
    SET last_run_date = CURRENT_DATE, next_run_date = ${nextDate}::DATE,
        run_count = run_count + 1, status = ${newStatus}
    WHERE id = ${id} AND company_id = ${companyId}
  `;

  log.info('Generated invoice from recurring', { recurringId: id, invoiceId }, 'accounting');
  return invoiceId;
}

type TemplateLineItem = { description: string; quantity: number; unitPrice: number };

function parseLineItems(raw: unknown): TemplateLineItem[] {
  const arr = Array.isArray(raw)
    ? raw
    : typeof raw === 'string' ? JSON.parse(raw) as unknown : [];
  return Array.isArray(arr) ? arr as TemplateLineItem[] : [];
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
