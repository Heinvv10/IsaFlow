import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import { markEntriesBilled } from './practiceTimeEntryWorkflow';
import type { PracticeTimeEntry } from './practiceTimeEntryTypes';

export interface WipClientRow {
  practiceClientId: string;
  legalName: string;
  linkCustomerId: string | null;
  totalHours: number;
  totalValue: number;
  oldestApprovedDate: string;
  entries: PracticeTimeEntry[];
}

export interface GenerateWipInvoiceInput {
  practiceClientId: string;
  timeEntryIds: string[];
  invoiceDate?: string;
  taxRate?: number;
  groupBy?: 'detailed' | 'by_work_item' | 'by_category';
}

export interface WipInvoiceResult {
  invoiceId: string;
  invoiceNumber: string;
  lineCount: number;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
}

export interface WipFilters {
  practiceClientId?: string;
  partnerId?: string;
  dateFrom?: string;
  dateTo?: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function mapWipEntry(r: DbRow): PracticeTimeEntry {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    userId: String(r.user_id),
    entryDate: typeof r.entry_date === 'string'
      ? r.entry_date
      : (r.entry_date as Date).toISOString().split('T')[0]!,
    hours: Number(r.hours),
    practiceClientId: String(r.practice_client_id),
    jobCategoryId: String(r.job_category_id),
    workItemId: String(r.work_item_id),
    taskDescription: String(r.task_description),
    notes: r.notes ? String(r.notes) : null,
    billable: Boolean(r.billable),
    appliedRate: r.applied_rate != null ? Number(r.applied_rate) : null,
    lineTotal: r.line_total != null ? Number(r.line_total) : null,
    origin: String(r.origin ?? 'manual') as PracticeTimeEntry['origin'],
    status: String(r.status) as PracticeTimeEntry['status'],
    approvedBy: r.approved_by ? String(r.approved_by) : null,
    approvedAt: r.approved_at ? String(r.approved_at) : null,
    billedAt: r.billed_at ? String(r.billed_at) : null,
    invoiceId: r.invoice_id ? String(r.invoice_id) : null,
    practiceClientName: r.practice_client_name ? String(r.practice_client_name) : null,
    jobCategoryName: r.job_category_name ? String(r.job_category_name) : null,
    workItemName: r.work_item_name ? String(r.work_item_name) : null,
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

export async function getWipByClient(
  companyId: string,
  filters?: WipFilters,
): Promise<WipClientRow[]> {
  const pc = filters?.practiceClientId ?? null;
  const partner = filters?.partnerId ?? null;
  const df = filters?.dateFrom ?? null;
  const dt = filters?.dateTo ?? null;

  const summary = (await sql`
    SELECT
      te.practice_client_id,
      pc.legal_name,
      pc.link_customer_id,
      SUM(te.hours)::NUMERIC AS total_hours,
      SUM(COALESCE(te.line_total, 0))::NUMERIC AS total_value,
      MIN(te.approved_at::DATE) AS oldest_approved_date
    FROM time_entries te
    JOIN practice_clients pc ON pc.id = te.practice_client_id
    WHERE te.company_id = ${companyId}::UUID
      AND te.status = 'approved'
      AND te.billed_at IS NULL
      AND te.billable = true
      AND te.practice_client_id IS NOT NULL
      AND (${pc}::UUID IS NULL OR te.practice_client_id = ${pc}::UUID)
      AND (${partner}::UUID IS NULL OR pc.assigned_partner_id = ${partner}::UUID)
      AND (${df}::DATE IS NULL OR te.entry_date >= ${df}::DATE)
      AND (${dt}::DATE IS NULL OR te.entry_date <= ${dt}::DATE)
    GROUP BY te.practice_client_id, pc.legal_name, pc.link_customer_id
    ORDER BY pc.legal_name
  `) as DbRow[];

  if (!summary.length) return [];

  const clientIds = summary.map((r) => String(r.practice_client_id));

  const entryRows = (await sql`
    SELECT te.*,
      pc.legal_name AS practice_client_name,
      pjc.name AS job_category_name,
      pwi.name AS work_item_name
    FROM time_entries te
    JOIN practice_clients pc ON pc.id = te.practice_client_id
    LEFT JOIN practice_job_categories pjc ON pjc.id = te.job_category_id
    LEFT JOIN practice_work_items pwi ON pwi.id = te.work_item_id
    WHERE te.company_id = ${companyId}::UUID
      AND te.status = 'approved'
      AND te.billed_at IS NULL
      AND te.billable = true
      AND te.practice_client_id = ANY(${clientIds}::UUID[])
      AND (${df}::DATE IS NULL OR te.entry_date >= ${df}::DATE)
      AND (${dt}::DATE IS NULL OR te.entry_date <= ${dt}::DATE)
    ORDER BY te.entry_date DESC, te.created_at DESC
  `) as DbRow[];

  const entriesByClient = new Map<string, PracticeTimeEntry[]>();
  for (const r of entryRows) {
    const cid = String(r.practice_client_id);
    const list = entriesByClient.get(cid) ?? [];
    list.push(mapWipEntry(r));
    entriesByClient.set(cid, list);
  }

  return summary.map((r) => {
    const cid = String(r.practice_client_id);
    const oldestRaw = r.oldest_approved_date;
    const oldestStr = oldestRaw instanceof Date
      ? oldestRaw.toISOString().split('T')[0]!
      : String(oldestRaw ?? '');
    return {
      practiceClientId: cid,
      legalName: String(r.legal_name),
      linkCustomerId: r.link_customer_id ? String(r.link_customer_id) : null,
      totalHours: Number(r.total_hours),
      totalValue: Number(r.total_value),
      oldestApprovedDate: oldestStr,
      entries: entriesByClient.get(cid) ?? [],
    };
  });
}

export async function generateWipInvoice(
  companyId: string,
  userId: string,
  input: GenerateWipInvoiceInput,
): Promise<WipInvoiceResult> {
  // 1. Validate practice client — active + link_customer_id required
  const clientRows = (await sql`
    SELECT id, status, link_customer_id FROM practice_clients
    WHERE id = ${input.practiceClientId}::UUID
      AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!clientRows[0] || clientRows[0].status !== 'active') {
    throw new Error('practice client not found or not active');
  }
  if (!clientRows[0].link_customer_id) {
    throw new Error(
      'practice client has no linked AR customer — set link_customer_id before generating an invoice',
    );
  }
  const customerId = String(clientRows[0].link_customer_id);

  // 2. Load eligible entries
  const entries = (await sql`
    SELECT te.id, te.hours, te.applied_rate, te.line_total,
      te.entry_date, te.task_description,
      te.work_item_id, te.job_category_id,
      pwi.name AS work_item_name,
      pjc.name AS job_category_name
    FROM time_entries te
    LEFT JOIN practice_work_items pwi ON pwi.id = te.work_item_id
    LEFT JOIN practice_job_categories pjc ON pjc.id = te.job_category_id
    WHERE te.id = ANY(${input.timeEntryIds}::UUID[])
      AND te.company_id = ${companyId}::UUID
      AND te.practice_client_id = ${input.practiceClientId}::UUID
      AND te.status = 'approved'
      AND te.billed_at IS NULL
      AND te.billable = true
      AND te.line_total IS NOT NULL
  `) as DbRow[];

  if (!entries.length) throw new Error('no eligible approved time entries in selection');

  const subtotal = round2(entries.reduce((s, e) => s + Number(e.line_total ?? 0), 0));
  const taxRate = input.taxRate ?? 15;
  const taxAmount = round2(subtotal * (taxRate / 100));
  const totalAmount = round2(subtotal + taxAmount);
  const invDate = input.invoiceDate ?? new Date().toISOString().split('T')[0]!;

  // 3. Generate invoice number with retry-on-collision
  let invoiceId = '';
  let invoiceNumber = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const maxRows = (await sql`
      SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM '[0-9]+$') AS INTEGER)), 0) AS max_num
      FROM customer_invoices WHERE company_id = ${companyId} AND invoice_number ~ '^INV-[0-9]+$'
    `) as DbRow[];
    const base = Number(maxRows[0]?.['max_num'] ?? 0) + 1 + attempt;
    invoiceNumber = `INV-${String(base).padStart(5, '0')}`;
    try {
      const invRows = (await sql`
        INSERT INTO customer_invoices (
          company_id, invoice_number, customer_id, client_id,
          subtotal, tax_rate, tax_amount, total_amount,
          invoice_date, status, created_by,
          currency_code, exchange_rate, functional_total
        ) VALUES (
          ${companyId}, ${invoiceNumber}, ${customerId}::UUID, ${customerId}::UUID,
          ${subtotal}, ${taxRate}, ${taxAmount}, ${totalAmount},
          ${invDate}, 'draft', ${userId},
          'ZAR', 1.0, ${totalAmount}
        ) RETURNING id
      `) as DbRow[];
      invoiceId = String(invRows[0]!.id);
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('unique') && attempt < 4) continue;
      throw err;
    }
  }

  // 4. Insert line items based on groupBy mode
  const groupBy = input.groupBy ?? 'detailed';
  let lineCount = 0;

  if (groupBy === 'detailed') {
    for (const e of entries) {
      const hours = Number(e.hours);
      const rate = Number(e.applied_rate);
      const lineAmount = Number(e.line_total);
      const wi = e.work_item_name ? ` [${String(e.work_item_name)}]` : '';
      const dateStr = typeof e.entry_date === 'string'
        ? e.entry_date.split('T')[0]
        : (e.entry_date as Date).toISOString().split('T')[0];
      const desc = `${dateStr}${wi} — ${String(e.task_description)} (${hours}h @ R${rate}/h)`;
      await sql`
        INSERT INTO customer_invoice_items (
          invoice_id, description, unit_price, quantity, amount, tax_rate, currency_code
        ) VALUES (
          ${invoiceId}::UUID, ${desc}, ${rate}, ${hours}, ${lineAmount}, ${taxRate}, 'ZAR'
        )
      `;
      lineCount++;
    }
  } else {
    // Group by work_item_id or job_category_id
    const keyOf = (e: DbRow): string =>
      groupBy === 'by_work_item' ? String(e.work_item_id) : String(e.job_category_id);
    const nameOf = (e: DbRow): string =>
      groupBy === 'by_work_item'
        ? String(e.work_item_name ?? 'Work item')
        : String(e.job_category_name ?? 'Category');

    const groups = new Map<string, { name: string; hours: number; value: number }>();
    for (const e of entries) {
      const k = keyOf(e);
      const prev = groups.get(k) ?? { name: nameOf(e), hours: 0, value: 0 };
      prev.hours += Number(e.hours);
      prev.value += Number(e.line_total);
      groups.set(k, prev);
    }

    for (const g of groups.values()) {
      const hours = round2(g.hours);
      const value = round2(g.value);
      const unit = hours > 0 ? round2(value / hours) : 0;
      await sql`
        INSERT INTO customer_invoice_items (
          invoice_id, description, unit_price, quantity, amount, tax_rate, currency_code
        ) VALUES (
          ${invoiceId}::UUID, ${g.name}, ${unit}, ${hours}, ${value}, ${taxRate}, 'ZAR'
        )
      `;
      lineCount++;
    }
  }

  // 5. Mark entries billed via workflow
  const eligibleIds = entries.map((e) => String(e.id));
  await markEntriesBilled(companyId, eligibleIds, invoiceId);

  log.info('Generated WIP invoice', {
    invoiceId, invoiceNumber, lineCount, subtotal, totalAmount,
  }, 'practice');

  return { invoiceId, invoiceNumber, lineCount, subtotal, taxAmount, totalAmount };
}
