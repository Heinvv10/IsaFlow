// src/modules/accounting/services/ar/portalInvoiceService.ts
// The invoice a portal link (token) opens, with the read receipt it writes. The portal invoice API route and the
// portal invoice page's getServerSideProps both call it, so the page never fetches its own API: through
// NEXT_PUBLIC_APP_URL that was the wrong server on a dev port, and on production an HTTP round trip through
// Cloudflare whose read receipt named the server's own address and user agent instead of the customer's.

import type { IncomingMessage } from 'http';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { trustedClientIp } from '@/lib/trustedClientIp';
import { hashSessionToken } from './portalTokenService';
import { logCustomerInvoiceView } from './readReceiptService';

/** The part of a request the read receipt needs: both a Next API request and a page's request have it. */
export type PortalViewerRequest = Pick<IncomingMessage, 'headers' | 'socket'>;

type Row = Record<string, unknown>;

export interface PortalInvoiceLineItem {
  id: string;
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
  amount: number;
}

export interface PortalInvoiceData {
  invoice_number: string;
  invoice_date: string;
  due_date: string | null;
  status: string;
  currency_code: string;
  subtotal: number;
  tax_amount: number;
  total_amount: number;
  amount_paid: number;
  notes: string | null;
  customer_name: string;
  company_name: string;
  company_logo_url: string | null;
  portal_viewed_at: string | null;
  portal_display_name: string | null;
  portal_primary_color: string | null;
  portal_allow_payments: boolean;
  portal_payment_instructions: string | null;
  items: PortalInvoiceLineItem[];
}


/**
 * The invoice for `token`, or null when the token is not a portal token or names no live invoice. Records the first
 * view and a per-view log row for the requester. Throws on a database error.
 */
export async function loadPortalInvoice(token: string, req: PortalViewerRequest): Promise<PortalInvoiceData | null> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const started = Date.now();
  const rows = (await sql`
    SELECT
      ci.id,
      ci.company_id,
      ci.invoice_number,
      ci.invoice_date,
      ci.due_date,
      ci.status,
      ci.currency_code,
      ci.subtotal,
      ci.tax_amount,
      ci.total_amount,
      ci.amount_paid,
      ci.notes,
      ci.portal_viewed_at,
      cu.name  AS customer_name,
      co.name  AS company_name,
      co.logo_url AS company_logo_url,
      co.portal_display_name,
      co.portal_primary_color,
      co.portal_allow_payments,
      co.portal_payment_instructions
    FROM customer_invoices ci
    LEFT JOIN customers cu ON cu.id = COALESCE(ci.client_id, ci.customer_id) AND cu.company_id = ci.company_id
    LEFT JOIN companies co ON co.id = ci.company_id
    WHERE ci.portal_token = ${token}
      AND ci.status != 'cancelled'
      AND ci.deleted_at IS NULL
    LIMIT 1
  `) as Row[];

  if (!rows[0]) return null;

  const inv = rows[0];
  const invoiceId = String(inv.id);
  const companyId = String(inv.company_id);

  if (!inv.portal_viewed_at) {
    await sql`
      UPDATE customer_invoices
      SET portal_viewed_at = NOW()
      WHERE id = ${invoiceId}::UUID AND portal_viewed_at IS NULL
    `;
    log.info('Portal invoice first view', { invoiceId }, 'Portal');
  }

  // PRD-06 Phase 2 — per-view log. IP is recorded for fraud screening in a later
  // phase; we never reject on change (decision: log-only).
  await logCustomerInvoiceView({
    invoiceId,
    companyId,
    viewSource: 'portal',
    sessionTokenHash: hashSessionToken(token),
    ipAddress: trustedClientIp(req),
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
    responseTimeMs: Date.now() - started,
  });

  // Fetch line items
  const itemRows = (await sql`
    SELECT id, description, quantity, unit_price, tax_rate, amount
    FROM customer_invoice_items
    WHERE invoice_id = ${invoiceId}::UUID
    ORDER BY line_position NULLS LAST, created_at, id -- the entry order (migration 956), as the PDF prints it
  `) as Row[];

  const items: PortalInvoiceLineItem[] = itemRows.map(r => ({
    id: String(r.id),
    description: String(r.description ?? ''),
    quantity: Number(r.quantity),
    unit_price: Number(r.unit_price),
    tax_rate: Number(r.tax_rate),
    amount: Number(r.amount),
  }));

  const data: PortalInvoiceData = {
    invoice_number: String(inv.invoice_number),
    invoice_date: String(inv.invoice_date ?? '').split('T')[0]!,
    due_date: inv.due_date != null ? (String(inv.due_date).split('T')[0] ?? null) : null,
    status: String(inv.status),
    currency_code: String(inv.currency_code ?? 'ZAR'),
    subtotal: Number(inv.subtotal),
    tax_amount: Number(inv.tax_amount),
    total_amount: Number(inv.total_amount),
    amount_paid: Number(inv.amount_paid ?? 0),
    notes: inv.notes ? String(inv.notes) : null,
    customer_name: String(inv.customer_name ?? 'Customer'),
    company_name: String(inv.company_name ?? 'ISAFlow'),
    company_logo_url: inv.company_logo_url != null ? String(inv.company_logo_url) : null,
    portal_viewed_at: inv.portal_viewed_at != null ? String(inv.portal_viewed_at) : null,
    portal_display_name: inv.portal_display_name != null ? String(inv.portal_display_name) : null,
    portal_primary_color: inv.portal_primary_color != null ? String(inv.portal_primary_color) : null,
    portal_allow_payments: Boolean(inv.portal_allow_payments ?? true),
    portal_payment_instructions: inv.portal_payment_instructions != null ? String(inv.portal_payment_instructions) : null,
    items,
  };

  return data;
}
