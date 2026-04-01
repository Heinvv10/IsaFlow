/**
 * Customer Invoice Create API (standalone, not project-linked)
 * POST — create invoice with line items
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);

  const { clientId, invoiceDate, dueDate, billingPeriodStart, billingPeriodEnd, taxRate, notes, items } = req.body;
  if (!clientId) return apiResponse.badRequest(res, 'clientId is required');
  if (!items || !Array.isArray(items) || items.length === 0) return apiResponse.badRequest(res, 'items required');

  try {
    const userId = String(req.user?.id || 'system');

    // Auto-generate invoice number (use MAX to avoid duplicates)
    const maxRows = (await sql`
      SELECT MAX(CAST(SUBSTRING(invoice_number FROM '[0-9]+$') AS INTEGER)) as max_num
      FROM customer_invoices WHERE company_id = ${companyId} AND invoice_number LIKE 'INV-%'
    `) as Row[];
    const nextNum = (Number(maxRows[0]?.max_num) || 0) + 1;
    const invoiceNumber = `INV-${String(nextNum).padStart(5, '0')}`;

    // Calculate totals
    const rate = taxRate ?? 15;
    let subtotal = 0;
    for (const item of items) {
      subtotal += (item.quantity || 1) * item.unitPrice;
    }
    subtotal = Math.round(subtotal * 100) / 100;
    const taxAmount = Math.round(subtotal * (rate / 100) * 100) / 100;
    const totalAmount = subtotal + taxAmount;

    const today = new Date().toISOString().split('T')[0];
    const invDate = invoiceDate || today;
    const bpStart = billingPeriodStart || null;
    const bpEnd = billingPeriodEnd || null;

    // Find project from client (optional)
    let projectId: string | null = null;
    try {
      const projRows = (await sql`SELECT id FROM projects WHERE client_id = ${clientId}::UUID LIMIT 1`) as Row[];
      projectId = projRows[0]?.id || null;
    } catch { /* projects table may not exist */ }

    const invRows = (await sql`
      INSERT INTO customer_invoices (
        company_id, invoice_number, project_id, customer_id, client_id, billing_period_start, billing_period_end,
        subtotal, tax_rate, tax_amount, total_amount, invoice_date, due_date,
        notes, status, created_by
      ) VALUES (
        ${companyId}, ${invoiceNumber}, ${projectId}, ${clientId}::UUID, ${clientId}::UUID, ${bpStart}, ${bpEnd},
        ${subtotal}, ${rate}, ${taxAmount}, ${totalAmount}, ${invDate},
        ${dueDate || null}, ${notes || null}, 'draft', ${userId}
      ) RETURNING id
    `) as Row[];

    const invoiceId = invRows[0].id;

    for (const item of items) {
      const qty = item.quantity || 1;
      const lineAmount = Math.round(qty * item.unitPrice * 100) / 100;
      await sql`
        INSERT INTO customer_invoice_items (invoice_id, description, unit_price, quantity, amount, tax_rate)
        VALUES (${invoiceId}::UUID, ${item.description}, ${item.unitPrice}, ${qty}, ${lineAmount}, ${rate})
      `;
    }

    log.info('Customer invoice created', { invoiceNumber, totalAmount });
    return apiResponse.created(res, { id: invoiceId, invoiceNumber });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Invoice create failed', { error: msg });
    const clientMessage = process.env.NODE_ENV === 'development' ? msg : 'Failed to create invoice';
    return res.status(500).json({ success: false, error: { code: 'CREATE_FAILED', message: clientMessage } });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
