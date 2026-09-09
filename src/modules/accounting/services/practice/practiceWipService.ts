import { sql, withSavepoint } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import { markEntriesBilled } from './practiceTimeEntryWorkflow';
import { mapEntry } from './practiceTimeEntryService';
import { lockEligibleWipEntries } from './wipEntryLock';
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

/** Postgres `unique_violation` — another run took this invoice number first. */
const UNIQUE_VIOLATION = '23505';

type GroupedLine = { name: string; hours: number; value: number };

function buildGroupedLines(entries: DbRow[], groupBy: 'by_work_item' | 'by_category'): Map<string, GroupedLine> {
  const wi = groupBy === 'by_work_item';
  const groups = new Map<string, GroupedLine>();
  for (const e of entries) {
    const k = wi ? String(e.work_item_id) : String(e.job_category_id);
    const name = wi ? String(e.work_item_name ?? 'Work item') : String(e.job_category_name ?? 'Category');
    const prev = groups.get(k) ?? { name, hours: 0, value: 0 };
    prev.hours += Number(e.hours); prev.value += Number(e.line_total);
    groups.set(k, prev);
  }
  return groups;
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
    list.push(mapEntry(r));
    entriesByClient.set(cid, list);
  }

  return summary.map((r) => {
    const cid = String(r.practice_client_id);
    const oldestApprovedDate = fmtDate(r.oldest_approved_date);
    return {
      practiceClientId: cid,
      legalName: String(r.legal_name),
      linkCustomerId: r.link_customer_id ? String(r.link_customer_id) : null,
      totalHours: Number(r.total_hours),
      totalValue: Number(r.total_value),
      oldestApprovedDate,
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
  if (!clientRows[0] || clientRows[0].status !== 'active')
    throw new Error('practice client not found or not active');
  if (!clientRows[0].link_customer_id)
    throw new Error('practice client has no linked AR customer — set link_customer_id before generating an invoice');
  const customerId = String(clientRows[0].link_customer_id);


  // 2. Load eligible entries, holding a row lock on each for the rest of the
  //    request so a concurrent run cannot bill the same hours (K-040).
  const entries = await lockEligibleWipEntries(companyId, input.practiceClientId, input.timeEntryIds);

  if (!entries.length) throw new Error('no eligible approved time entries in selection');

  const subtotal = round2(entries.reduce((s, e) => s + Number(e.line_total ?? 0), 0));
  const taxRate = input.taxRate ?? 15;
  const taxAmount = round2(subtotal * (taxRate / 100));
  const totalAmount = round2(subtotal + taxAmount);
  const invDate = input.invoiceDate ?? new Date().toISOString().split('T')[0]!;
  const eligibleIds = entries.map((e) => String(e.id));

  // Steps 3-5 write; the route answers a caught error with a 400, which withAuth
  // COMMITs. The savepoint is what makes the billed-count guard below able to
  // undo the invoice instead of leaving an orphan behind.
  return withSavepoint('wip_invoice_build', async () => {
    // 3. Generate invoice number with retry-on-collision
    let invoiceId = '';
    let invoiceNumber = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      const maxRows = (await sql`
        SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM '[0-9]+$') AS INTEGER)), 0) AS max_num
        FROM customer_invoices WHERE company_id = ${companyId}::UUID AND invoice_number ~ '^INV-[0-9]+$'
      `) as DbRow[];
      const base = Number(maxRows[0]?.['max_num'] ?? 0) + 1 + attempt;
      invoiceNumber = `INV-${String(base).padStart(5, '0')}`;
      try {
        // Own savepoint per attempt: a peer's concurrent number is a 23505, and
        // a caught error aborts the whole transaction unless something rolls it
        // back. Without this the `continue` below cannot execute a single
        // further statement and the retry never happens.
        invoiceId = await withSavepoint(`wip_inv_try_${attempt}`, async () => {
          const invRows = (await sql`
            INSERT INTO customer_invoices (
              company_id, invoice_number, customer_id, client_id,
              subtotal, tax_rate, tax_amount, total_amount,
              invoice_date, status, created_by,
              currency_code, exchange_rate, functional_total
            ) VALUES (
              ${companyId}::UUID, ${invoiceNumber}, ${customerId}::UUID, ${customerId}::UUID,
              ${subtotal}, ${taxRate}, ${taxAmount}, ${totalAmount},
              ${invDate}, 'draft', ${userId},
              'ZAR', 1.0, ${totalAmount}
            ) RETURNING id
          `) as DbRow[];
          return String(invRows[0]!.id);
        });
        break;
      } catch (err) {
        const code = typeof err === 'object' && err !== null
          ? (err as { code?: unknown }).code : undefined;
        const msg = err instanceof Error ? err.message : String(err);
        if ((code === UNIQUE_VIOLATION || msg.includes('unique')) && attempt < 4) {
          log.warn('Invoice number collision, retrying', { attempt, invoiceNumber, companyId }, 'practice');
          continue;
        }
        throw err;
      }
    }
    if (!invoiceId) {
      throw new Error('invoice number generation failed — exhausted 5 attempts');
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
        const dateStr = fmtDate(e.entry_date);
        const desc = `${dateStr}${wi} — ${String(e.task_description)} (${hours}h @ R${rate}/h)`;
        await sql`
          INSERT INTO customer_invoice_items (
            invoice_id, description, unit_price, quantity, amount, tax_rate, currency_code, time_entry_id
          ) VALUES (
            ${invoiceId}::UUID, ${desc}, ${rate}, ${hours}, ${lineAmount}, ${taxRate}, 'ZAR', ${String(e.id)}::UUID
          )
        `;
        lineCount++;
      }
    } else {
      const groups = buildGroupedLines(entries, groupBy);
      for (const g of groups.values()) {
        const hours = round2(g.hours);
        const value = round2(g.value);
        const unit = hours > 0 ? round2(value / hours) : 0;
        await sql`
          INSERT INTO customer_invoice_items (
            invoice_id, description, unit_price, quantity, amount, tax_rate, currency_code, time_entry_id
          ) VALUES (
            ${invoiceId}::UUID, ${g.name}, ${unit}, ${hours}, ${value}, ${taxRate}, 'ZAR', ${null as null}
          )
        `;
        lineCount++;
      }
    }

    // 5. Mark entries billed via workflow. The count is the workflow's way of
    //    reporting a loss: anything short of the full selection means an entry
    //    was billed elsewhere, so this invoice must not stand.
    let marked: number;
    try {
      marked = await markEntriesBilled(companyId, eligibleIds, invoiceId);
    } catch (err) {
      log.error('markEntriesBilled failed after invoice creation — invoice rolled back', {
        invoiceId,
        invoiceNumber,
        entryCount: eligibleIds.length,
        error: err instanceof Error ? err.message : String(err),
      }, 'practice');
      throw err;
    }
    if (marked !== eligibleIds.length) {
      log.error('WIP invoice billed fewer entries than selected — rolling back', {
        invoiceId, invoiceNumber, marked, selected: eligibleIds.length,
      }, 'practice');
      throw new Error('time entries were billed concurrently — invoice not generated');
    }

    log.info('Generated WIP invoice', {
      invoiceId, invoiceNumber, lineCount, subtotal, totalAmount,
    }, 'practice');

    return { invoiceId, invoiceNumber, lineCount, subtotal, taxAmount, totalAmount };
  });
}
