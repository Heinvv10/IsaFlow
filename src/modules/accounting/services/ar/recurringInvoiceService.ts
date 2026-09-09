import {requireArControl} from './arControlBoundary';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {resolveArAccounts} from '../controls/arControlAccounts';
/**
 * Recurring Invoice Service
 * Phase 1 Sage Alignment: Auto-generate customer invoices on schedule
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  RecurringInvoiceTemplateError,
} from './recurringInvoiceTemplate';
import { RecurringInvoiceLockTimeoutError } from './recurringInvoiceLock';
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
  const ctx=requireArControl(companyId,userId);
  await assertEffectivePermission(ctx,'write:invoices');
  const {ledgerCurrency}=await resolveArAccounts(ctx,[]);
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
      total_amount, payment_terms, created_by, currency_code
    ) VALUES (
      ${companyId}, ${input.templateName}, ${input.clientId}::UUID,
      ${input.projectId || null}, ${input.frequency}, ${input.nextRunDate},
      ${input.endDate || null}, ${input.description || null},
      ${JSON.stringify(input.lineItems)}::JSONB, ${subtotal}, ${taxRate},
      ${taxAmount}, ${totalAmount}, ${input.paymentTerms || '30 days'}, ${userId}::UUID, ${ledgerCurrency}
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

export {generateInvoiceFromRecurring,prepareRecurringInvoiceRun} from './recurringInvoiceControl';

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
