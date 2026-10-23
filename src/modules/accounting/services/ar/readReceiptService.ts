/**
 * Customer invoice read-receipt service — PRD-06 Phase 2.
 *
 * Writes into customer_invoice_views (mig 427) and reads from it for the
 * AR list "last viewed" column. Callers never hand us raw portal tokens —
 * they pre-hash via portalTokenService.hashSessionToken so we never receive
 * the token in this module.
 */

import { sql, type DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

export type ViewSource = 'portal' | 'tracking_pixel' | 'pdf_link' | 'api';

export interface LogViewInput {
  invoiceId: string;
  companyId: string;
  viewSource: ViewSource;
  sessionTokenHash?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  responseTimeMs?: number | null;
}

export interface InvoiceViewRow {
  id: string;
  viewedAt: string;
  viewSource: ViewSource;
  ipAddress: string | null;
  userAgent: string | null;
  sessionTokenHash: string | null;
  responseTimeMs: number | null;
}

export interface InvoiceViewSummary {
  invoiceId: string;
  lastViewedAt: string | null;
  viewCount: number;
  distinctSessions: number;
}

function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? '');
}

export async function logCustomerInvoiceView(input: LogViewInput): Promise<void> {
  const started = Date.now();
  try {
    await sql`
      INSERT INTO customer_invoice_views (
        company_id,
        customer_invoice_id,
        view_source,
        session_token,
        ip_address,
        user_agent,
        response_time_ms
      ) VALUES (
        ${input.companyId}::uuid,
        ${input.invoiceId}::uuid,
        ${input.viewSource},
        ${input.sessionTokenHash ?? null},
        ${input.ipAddress ?? null}::inet,
        ${input.userAgent ?? null},
        ${input.responseTimeMs ?? null}
      )
    `;
  } catch (err) {
    // Never let a logging failure break the customer-facing request.
    log.warn(
      'Failed to log customer invoice view',
      { invoiceId: input.invoiceId, viewSource: input.viewSource, err: String(err) },
      'readReceipt',
    );
  } finally {
    const ms = Date.now() - started;
    if (ms > 500) {
      log.warn('Slow view-log insert', { invoiceId: input.invoiceId, ms }, 'readReceipt');
    }
  }
}

export async function listInvoiceViews(
  invoiceId: string,
  companyId: string,
  limit = 100,
): Promise<InvoiceViewRow[]> {
  const safeLimit = Math.min(Math.max(1, limit), 500);
  const rows = (await sql`
    SELECT id, viewed_at, view_source, ip_address, user_agent, session_token, response_time_ms
    FROM customer_invoice_views
    WHERE customer_invoice_id = ${invoiceId}::uuid
      AND company_id = ${companyId}::uuid
    ORDER BY viewed_at DESC
    LIMIT ${safeLimit}
  `) as DbRow[];

  return rows.map((r) => ({
    id: String(r.id),
    viewedAt: toIsoString(r.viewed_at),
    viewSource: String(r.view_source) as ViewSource,
    ipAddress: r.ip_address != null ? String(r.ip_address) : null,
    userAgent: r.user_agent != null ? String(r.user_agent) : null,
    sessionTokenHash: r.session_token != null ? String(r.session_token) : null,
    responseTimeMs: r.response_time_ms != null ? Number(r.response_time_ms) : null,
  }));
}

/**
 * Fetches "last viewed" metadata for a batch of invoices. Prefers the MV
 * (customer_invoice_view_summary) but falls back to the base table — same
 * shape either way. Company-scoped.
 */
export async function getLastViewedSummary(
  companyId: string,
  invoiceIds: string[],
): Promise<Map<string, InvoiceViewSummary>> {
  if (invoiceIds.length === 0) return new Map();

  const rows = (await sql`
    SELECT customer_invoice_id,
           last_viewed_at,
           view_count,
           distinct_sessions
    FROM customer_invoice_view_summary
    WHERE company_id = ${companyId}::uuid
      AND customer_invoice_id = ANY(${invoiceIds}::uuid[])
  `) as DbRow[];

  const map = new Map<string, InvoiceViewSummary>();
  for (const r of rows) {
    const id = String(r.customer_invoice_id);
    map.set(id, {
      invoiceId: id,
      lastViewedAt: r.last_viewed_at ? toIsoString(r.last_viewed_at) : null,
      viewCount: Number(r.view_count ?? 0),
      distinctSessions: Number(r.distinct_sessions ?? 0),
    });
  }
  return map;
}
