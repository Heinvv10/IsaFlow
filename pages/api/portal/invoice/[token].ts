/**
 * Portal Invoice API — Public, token-based (no auth required)
 * GET  /api/portal/invoice/[token] — fetch invoice for public view
 * POST /api/portal/invoice/[token]?action=generate — generate token (internal, needs auth)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import crypto from 'crypto';

type Row = Record<string, unknown>;

interface PortalInvoiceLineItem {
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
  amount: number;
}

interface PortalInvoiceData {
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

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const token = req.query.token as string;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    return apiResponse.notFound(res, 'Invoice');
  }

  const rows = (await sql`
    SELECT
      ci.id,
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
    LEFT JOIN customers cu ON cu.id = ci.client_id
    LEFT JOIN companies co ON co.id = ci.company_id
    WHERE ci.portal_token = ${token}
      AND ci.status != 'cancelled'
      AND ci.deleted_at IS NULL
    LIMIT 1
  `) as Row[];

  if (!rows[0]) {
    return apiResponse.notFound(res, 'Invoice');
  }

  const inv = rows[0];
  const invoiceId = String(inv.id);

  // Mark first view
  if (!inv.portal_viewed_at) {
    await sql`
      UPDATE customer_invoices
      SET portal_viewed_at = NOW()
      WHERE id = ${invoiceId}::UUID AND portal_viewed_at IS NULL
    `;
    log.info('Portal invoice first view', { invoiceId }, 'Portal');
  }

  // Fetch line items
  const itemRows = (await sql`
    SELECT description, quantity, unit_price, tax_rate, amount
    FROM customer_invoice_items
    WHERE invoice_id = ${invoiceId}::UUID
    ORDER BY created_at ASC
  `) as Row[];

  const items: PortalInvoiceLineItem[] = itemRows.map(r => ({
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

  return apiResponse.success(res, data);
}

async function handleGenerateToken(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { invoiceId } = req.body as { invoiceId?: string };
  if (!invoiceId) {
    return apiResponse.badRequest(res, 'invoiceId is required');
  }

  const userId = req.user.id;
  const companyRows = (await sql`
    SELECT company_id FROM company_users
    WHERE user_id = ${userId}
    ORDER BY is_default DESC, created_at ASC
    LIMIT 1
  `) as Row[];

  if (!companyRows[0]) {
    return apiResponse.badRequest(res, 'No company assigned to user');
  }
  const companyId = String(companyRows[0].company_id);

  // Verify invoice belongs to this company
  const existing = (await sql`
    SELECT id, portal_token FROM customer_invoices
    WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
      AND status != 'cancelled'
    LIMIT 1
  `) as Row[];

  if (!existing[0]) {
    return apiResponse.notFound(res, 'Invoice');
  }

  // Return existing token or generate new one
  let token = existing[0].portal_token ? String(existing[0].portal_token) : null;
  if (!token) {
    token = crypto.randomBytes(32).toString('hex');
    await sql`
      UPDATE customer_invoices
      SET portal_token = ${token}
      WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
    `;
    log.info('Portal token generated', { invoiceId }, 'Portal');
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3101';
  const portalUrl = `${appUrl}/portal/invoice/${token}`;

  return apiResponse.success(res, { token, portalUrl });
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    return handleGet(req, res);
  }
  if (req.method === 'POST') {
    return withAuth(
      (authReq, authRes) => handleGenerateToken(authReq as AuthenticatedNextApiRequest, authRes)
    )(req, res);
  }
  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

export default withErrorHandler(handler);
