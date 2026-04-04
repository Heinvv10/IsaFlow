/**
 * Invoice Service
 * Admin invoice lifecycle for the ISAFlow Admin Platform.
 * Subscription operations are in billingService.ts.
 */

import { sql, withTransaction } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { InvoiceListItem, PaginatedResult } from '../types/admin.types';
type Row = Record<string, unknown>;


function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return value as string;
}

const ALLOWED_SORT: Record<string, string> = {
  created_at: 'i.created_at',
  due_date: 'i.due_date',
  status: 'i.status',
  total_cents: 'i.total_cents',
  company_name: 'c.name',
  invoice_number: 'i.invoice_number',
};

export async function listInvoices(filters: {
  company_id?: string;
  status?: string;
  from_date?: string;
  to_date?: string;
  search?: string;
  page?: number;
  limit?: number;
  sort_by?: string;
  sort_dir?: 'asc' | 'desc';
}): Promise<PaginatedResult<InvoiceListItem>> {
  const page = Math.max(1, filters.page ?? 1);
  const limit = Math.min(100, Math.max(1, filters.limit ?? 25));
  const offset = (page - 1) * limit;
  const sortColKey = filters.sort_by ?? '';
  if (sortColKey && !ALLOWED_SORT[sortColKey]) throw new Error(`Invalid sort column: ${sortColKey}`);
  const sortCol = ALLOWED_SORT[sortColKey] ?? 'i.created_at';
  const rawDir = (filters.sort_dir ?? 'desc').toUpperCase();
  if (rawDir !== 'ASC' && rawDir !== 'DESC') throw new Error('Invalid sort direction');
  const sortDir = rawDir === 'ASC' ? sql`ASC` : sql`DESC`;
  const search = filters.search ? `%${filters.search}%` : null;

  const [countRow] = await sql`
    SELECT COUNT(*) AS total
    FROM admin_invoices i
    INNER JOIN companies c ON c.id = i.company_id
    WHERE (${filters.company_id ?? null}::uuid IS NULL
           OR i.company_id = ${filters.company_id ?? null}::uuid)
      AND (${filters.status ?? null}::text IS NULL
           OR i.status = ${filters.status ?? null})
      AND (${filters.from_date ?? null}::date IS NULL
           OR i.created_at::date >= ${filters.from_date ?? null}::date)
      AND (${filters.to_date ?? null}::date IS NULL
           OR i.created_at::date <= ${filters.to_date ?? null}::date)
      AND (${search}::text IS NULL
           OR c.name ILIKE ${search}
           OR i.invoice_number ILIKE ${search})
  `;

  const rows = await sql`
    SELECT
      i.id, i.company_id, c.name AS company_name,
      i.invoice_number, i.status,
      i.subtotal_cents, i.tax_cents, i.total_cents, i.currency,
      i.due_date, i.paid_at, i.payment_method,
      i.created_at
    FROM admin_invoices i
    INNER JOIN companies c ON c.id = i.company_id
    WHERE (${filters.company_id ?? null}::uuid IS NULL
           OR i.company_id = ${filters.company_id ?? null}::uuid)
      AND (${filters.status ?? null}::text IS NULL
           OR i.status = ${filters.status ?? null})
      AND (${filters.from_date ?? null}::date IS NULL
           OR i.created_at::date >= ${filters.from_date ?? null}::date)
      AND (${filters.to_date ?? null}::date IS NULL
           OR i.created_at::date <= ${filters.to_date ?? null}::date)
      AND (${search}::text IS NULL
           OR c.name ILIKE ${search}
           OR i.invoice_number ILIKE ${search})
    ORDER BY ${sql.unsafe(sortCol)} ${sortDir}
    LIMIT ${limit} OFFSET ${offset}
  `;

  const total = parseInt((countRow as Row).total as string, 10);
  log.info(`listInvoices: ${rows.length} rows (page ${page})`, {}, 'InvoiceService');

  return {
    items: (rows as Row[]).map((r: Row) => ({
      id: r.id as string,
      company_id: r.company_id as string,
      company_name: r.company_name as string,
      invoice_number: r.invoice_number as string,
      status: r.status as string,
      subtotal_cents: r.subtotal_cents as number,
      tax_cents: r.tax_cents as number,
      total_cents: r.total_cents as number,
      currency: r.currency as string,
      due_date: toIso(r.due_date),
      paid_at: toIso(r.paid_at),
      payment_method: r.payment_method as string | null,
      created_at: toIso(r.created_at) ?? '',
    })),
    total,
    page,
    limit,
    total_pages: Math.ceil(total / limit),
  };
}

export async function createInvoice(data: {
  company_id: string;
  subscription_id?: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  due_date?: string;
  line_items?: unknown[];
  notes?: string;
}): Promise<string> {
  const {
    company_id,
    subscription_id = null,
    subtotal_cents,
    tax_cents,
    total_cents,
    due_date = null,
    line_items = [],
    notes = null,
  } = data;

  // Sequential invoice number: INV-YYYYMM-XXXX
  // Wrapped in a transaction to prevent race conditions on sequence generation.
  const id = await withTransaction(async (tx) => {
    const yyyymm = new Date().toISOString().slice(0, 7).replace('-', '');
    const prefix = `INV-${yyyymm}-`;

    const seqRows = (await tx`
      SELECT COUNT(*) AS count FROM admin_invoices
      WHERE invoice_number LIKE ${prefix + '%'}
    `) as Row[];
    const seq = parseInt((seqRows[0] as Row).count as string, 10) + 1;
    const invoice_number = `${prefix}${String(seq).padStart(4, '0')}`;

    const rows = (await tx`
      INSERT INTO admin_invoices (
        company_id, subscription_id, invoice_number, status,
        subtotal_cents, tax_cents, total_cents, currency,
        due_date, line_items, notes, created_at
      ) VALUES (
        ${company_id}::uuid,
        ${subscription_id}::uuid,
        ${invoice_number}, 'draft',
        ${subtotal_cents}, ${tax_cents}, ${total_cents}, 'ZAR',
        ${due_date}::date,
        ${JSON.stringify(line_items)}::jsonb,
        ${notes},
        NOW()
      )
      RETURNING id
    `) as Row[];

    log.info('createInvoice', { id: (rows[0] as Row).id, invoice_number, company_id }, 'InvoiceService');
    return (rows[0] as Row).id as string;
  });

  return id;
}

export async function markInvoicePaid(
  invoiceId: string,
  paymentMethod: string
): Promise<boolean> {
  const rows = await sql`
    UPDATE admin_invoices
    SET status         = 'paid',
        paid_at        = NOW(),
        payment_method = ${paymentMethod}
    WHERE id = ${invoiceId}
      AND status IN ('sent', 'overdue')
    RETURNING id
  `;
  const updated = rows.length > 0;
  log.info('markInvoicePaid', { invoiceId, paymentMethod, updated }, 'InvoiceService');
  return updated;
}

export async function sendInvoice(invoiceId: string): Promise<void> {
  await sql`
    UPDATE admin_invoices
    SET status = 'sent'
    WHERE id   = ${invoiceId}
      AND status = 'draft'
  `;
  log.info('sendInvoice', { invoiceId }, 'InvoiceService');
}
