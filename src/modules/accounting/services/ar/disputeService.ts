/**
 * Customer invoice dispute service — PRD-06 Phase 3.
 *
 * Dispute lifecycle: open → resolved | rejected | withdrawn.
 * Re-raising a dispute after resolution creates a NEW row; history is kept.
 * Only one OPEN dispute per (invoice, line) is allowed — enforced by partial
 * unique indexes in mig 428.
 *
 * Resolution modes (user-choice, per Hein 2026-04-23):
 *   resolve_with_credit → auto-creates a customer credit note for
 *                         disputed_amount and stores the id on the dispute.
 *   resolve_no_credit   → status=resolved, no credit, AR aging re-includes
 *                         the amount in overdue.
 *   rejected            → status=rejected, no credit, amount re-ages.
 *   withdrawn           → status=withdrawn (used by withdrawDispute).
 */

import { sql, type DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';

export type DisputeStatus = 'open' | 'resolved' | 'withdrawn' | 'rejected';
export type DisputeResolutionMode =
  | 'resolve_with_credit'
  | 'resolve_no_credit'
  | 'rejected'
  | 'withdrawn';

const ELIGIBLE_STATUSES = ['sent', 'approved', 'partially_paid', 'overdue'] as const;

export interface Dispute {
  id: string;
  companyId: string;
  customerInvoiceId: string;
  customerInvoiceLineId: string | null;
  reason: string;
  raisedBy: string;
  raisedAt: string;
  status: DisputeStatus;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  resolutionMode: DisputeResolutionMode | null;
  creditNoteId: string | null;
  disputedAmount: number;
  sourceDocumentId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface RaiseDisputeInput {
  customerInvoiceId: string;
  customerInvoiceLineId?: string | null;
  reason: string;
  disputedAmount: number;
  raisedBy: string;
  sourceDocumentId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface ListDisputesFilters {
  status?: DisputeStatus;
  customerInvoiceId?: string;
  limit?: number;
  offset?: number;
}

export interface ResolveDisputeInput {
  mode: 'resolve_with_credit' | 'resolve_no_credit' | 'rejected';
  note?: string;
  creditDate?: string;
}

function toIsoOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function mapRow(r: DbRow): Dispute {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    customerInvoiceId: String(r.customer_invoice_id),
    customerInvoiceLineId:
      r.customer_invoice_line_id != null ? String(r.customer_invoice_line_id) : null,
    reason: String(r.reason),
    raisedBy: String(r.raised_by),
    raisedAt: toIsoOrNull(r.raised_at) ?? '',
    status: String(r.status) as DisputeStatus,
    resolvedAt: toIsoOrNull(r.resolved_at),
    resolvedBy: r.resolved_by != null ? String(r.resolved_by) : null,
    resolutionNote: r.resolution_note != null ? String(r.resolution_note) : null,
    resolutionMode:
      r.resolution_mode != null ? (String(r.resolution_mode) as DisputeResolutionMode) : null,
    creditNoteId: r.credit_note_id != null ? String(r.credit_note_id) : null,
    disputedAmount: Number(r.disputed_amount),
    sourceDocumentId: r.source_document_id != null ? String(r.source_document_id) : null,
    ipAddress: r.ip_address != null ? String(r.ip_address) : null,
    userAgent: r.user_agent != null ? String(r.user_agent) : null,
  };
}

export async function raiseDispute(
  companyId: string,
  input: RaiseDisputeInput,
): Promise<Dispute> {
  if (!Number.isFinite(input.disputedAmount) || input.disputedAmount <= 0) {
    throw new Error('Disputed amount must be greater than zero');
  }
  if (!input.reason || input.reason.trim().length === 0) {
    throw new Error('Dispute reason is required');
  }

  const invoiceRows = (await sql`
    SELECT id, company_id, status, client_id, total_amount, amount_paid, invoice_number
    FROM customer_invoices
    WHERE id = ${input.customerInvoiceId}::uuid
      AND company_id = ${companyId}::uuid
      AND status = ANY(${ELIGIBLE_STATUSES as unknown as string[]}::text[])
      AND deleted_at IS NULL
    LIMIT 1
  `) as DbRow[];

  if (!invoiceRows[0]) {
    throw new Error(
      `Invoice not found or not eligible for dispute: ${input.customerInvoiceId}`,
    );
  }

  const invoice = invoiceRows[0];
  const outstanding = Number(invoice.total_amount) - Number(invoice.amount_paid ?? 0);
  if (input.disputedAmount > outstanding + 0.01) {
    throw new Error(
      `Disputed amount ${input.disputedAmount} exceeds outstanding balance ${outstanding}`,
    );
  }

  try {
    const rows = (await sql`
      INSERT INTO customer_invoice_disputes (
        company_id,
        customer_invoice_id,
        customer_invoice_line_id,
        reason,
        raised_by,
        disputed_amount,
        source_document_id,
        ip_address,
        user_agent
      ) VALUES (
        ${companyId}::uuid,
        ${input.customerInvoiceId}::uuid,
        ${input.customerInvoiceLineId ?? null},
        ${input.reason.trim()},
        ${input.raisedBy},
        ${input.disputedAmount},
        ${input.sourceDocumentId ?? null},
        ${input.ipAddress ?? null}::inet,
        ${input.userAgent ?? null}
      ) RETURNING *
    `) as DbRow[];

    log.info(
      'Dispute raised',
      {
        disputeId: String(rows[0]!.id),
        invoiceId: input.customerInvoiceId,
        disputedAmount: input.disputedAmount,
        raisedBy: input.raisedBy,
      },
      'dispute',
    );

    return mapRow(rows[0]!);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '23505') {
      throw new Error('There is already an open dispute on this invoice or line');
    }
    throw err;
  }
}

export async function listDisputes(
  companyId: string,
  filters: ListDisputesFilters = {},
): Promise<{ disputes: Dispute[]; total: number }> {
  const limit = Math.min(Math.max(1, filters.limit ?? 50), 200);
  const offset = Math.max(0, filters.offset ?? 0);

  let rows: DbRow[];
  if (filters.status && filters.customerInvoiceId) {
    rows = (await sql`
      SELECT d.*, ci.invoice_number, ci.client_id, c.name AS client_name
      FROM customer_invoice_disputes d
      JOIN customer_invoices ci ON ci.id = d.customer_invoice_id
      LEFT JOIN customers c ON c.id = ci.client_id
      WHERE d.company_id = ${companyId}::uuid
        AND d.status = ${filters.status}
        AND d.customer_invoice_id = ${filters.customerInvoiceId}::uuid
      ORDER BY d.raised_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `) as DbRow[];
  } else if (filters.status) {
    rows = (await sql`
      SELECT d.*, ci.invoice_number, ci.client_id, c.name AS client_name
      FROM customer_invoice_disputes d
      JOIN customer_invoices ci ON ci.id = d.customer_invoice_id
      LEFT JOIN customers c ON c.id = ci.client_id
      WHERE d.company_id = ${companyId}::uuid
        AND d.status = ${filters.status}
      ORDER BY d.raised_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `) as DbRow[];
  } else if (filters.customerInvoiceId) {
    rows = (await sql`
      SELECT d.*, ci.invoice_number, ci.client_id, c.name AS client_name
      FROM customer_invoice_disputes d
      JOIN customer_invoices ci ON ci.id = d.customer_invoice_id
      LEFT JOIN customers c ON c.id = ci.client_id
      WHERE d.company_id = ${companyId}::uuid
        AND d.customer_invoice_id = ${filters.customerInvoiceId}::uuid
      ORDER BY d.raised_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `) as DbRow[];
  } else {
    rows = (await sql`
      SELECT d.*, ci.invoice_number, ci.client_id, c.name AS client_name
      FROM customer_invoice_disputes d
      JOIN customer_invoices ci ON ci.id = d.customer_invoice_id
      LEFT JOIN customers c ON c.id = ci.client_id
      WHERE d.company_id = ${companyId}::uuid
      ORDER BY d.raised_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `) as DbRow[];
  }

  const disputes = rows.map((r) => ({
    ...mapRow(r),
    invoiceNumber: r.invoice_number != null ? String(r.invoice_number) : null,
    clientName: r.client_name != null ? String(r.client_name) : null,
  })) as Dispute[];

  return { disputes, total: disputes.length };
}

export async function getDispute(
  companyId: string,
  id: string,
): Promise<Dispute | null> {
  const rows = (await sql`
    SELECT * FROM customer_invoice_disputes
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
    LIMIT 1
  `) as DbRow[];

  return rows[0] ? mapRow(rows[0]) : null;
}

export async function resolveDispute(
  companyId: string,
  id: string,
  userId: string,
  input: ResolveDisputeInput,
): Promise<Dispute> {
  const existing = (await sql`
    SELECT d.*, ci.client_id
    FROM customer_invoice_disputes d
    LEFT JOIN customer_invoices ci ON ci.id = d.customer_invoice_id
    WHERE d.id = ${id}::uuid AND d.company_id = ${companyId}::uuid
    LIMIT 1
  `) as DbRow[];

  if (!existing[0]) {
    throw new Error(`Dispute ${id} not found`);
  }
  if (String(existing[0].status) !== 'open') {
    throw new Error(`Dispute ${id} is not open (current status: ${existing[0].status})`);
  }

  let creditNoteId: string | null = null;

  if (input.mode === 'resolve_with_credit') {
    if (!input.creditDate) {
      throw new Error('creditDate is required when resolving with credit');
    }

    const invoiceRows = (await sql`
      SELECT client_id FROM customer_invoices
      WHERE id = ${existing[0].customer_invoice_id}::uuid
        AND company_id = ${companyId}::uuid
      LIMIT 1
    `) as DbRow[];

    const clientId = invoiceRows[0]?.client_id != null ? String(invoiceRows[0].client_id) : null;
    if (!clientId) {
      throw new Error('Cannot auto-create credit note: invoice has no client');
    }

    const cn = await createCreditNote(
      companyId,
      {
        type: 'customer',
        clientId,
        customerInvoiceId: String(existing[0].customer_invoice_id),
        creditDate: input.creditDate,
        reason: `Dispute resolution: ${existing[0].reason ?? ''}`.slice(0, 500),
        subtotal: Number(existing[0].disputed_amount),
        taxRate: 0,
      },
      userId,
    );
    creditNoteId = String(cn.id);
  }

  const newStatus: DisputeStatus = input.mode === 'rejected' ? 'rejected' : 'resolved';

  const rows = (await sql`
    UPDATE customer_invoice_disputes
    SET status = ${newStatus},
        resolution_mode = ${input.mode},
        resolution_note = ${input.note ?? null},
        credit_note_id = ${creditNoteId},
        resolved_at = NOW(),
        resolved_by = ${userId}::uuid
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
    RETURNING *
  `) as DbRow[];

  log.info(
    'Dispute resolved',
    { disputeId: id, mode: input.mode, creditNoteId, userId },
    'dispute',
  );

  return mapRow(rows[0]!);
}

export async function withdrawDispute(
  companyId: string,
  id: string,
  userId: string,
  note?: string,
): Promise<Dispute> {
  const existing = (await sql`
    SELECT status FROM customer_invoice_disputes
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
    LIMIT 1
  `) as DbRow[];

  if (!existing[0]) {
    throw new Error(`Dispute ${id} not found`);
  }
  if (String(existing[0].status) !== 'open') {
    throw new Error(`Dispute ${id} is not open (current status: ${existing[0].status})`);
  }

  const rows = (await sql`
    UPDATE customer_invoice_disputes
    SET status = 'withdrawn',
        resolution_mode = 'withdrawn',
        resolution_note = ${note ?? null},
        resolved_at = NOW(),
        resolved_by = ${userId}::uuid
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
    RETURNING *
  `) as DbRow[];

  return mapRow(rows[0]!);
}

/**
 * Per-invoice open-dispute totals, keyed by customer_invoice_id. Used by AR
 * aging to split the "disputed" bucket out of "overdue".
 */
export async function getOpenDisputeTotals(
  companyId: string,
  invoiceIds: string[],
): Promise<Map<string, number>> {
  if (invoiceIds.length === 0) return new Map();

  const rows = (await sql`
    SELECT customer_invoice_id, SUM(disputed_amount) AS total
    FROM customer_invoice_disputes
    WHERE company_id = ${companyId}::uuid
      AND status = 'open'
      AND customer_invoice_id = ANY(${invoiceIds}::uuid[])
    GROUP BY customer_invoice_id
  `) as DbRow[];

  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(String(r.customer_invoice_id), Number(r.total ?? 0));
  }
  return map;
}
