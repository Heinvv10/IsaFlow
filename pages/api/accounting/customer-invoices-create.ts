/**
 * Customer Invoice Create API (standalone, not project-linked)
 * POST — create invoice with line items
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withFlowMeter } from '@/lib/billing/withFlowMeter';
import { getFlowCost } from '@/modules/billing/services/flowOperationCatalog';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { reserveNextDocumentNumber } from '@/modules/accounting/services/core/companyService';
type Row = Record<string, unknown>;


async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);

  const {
    clientId, invoiceDate, dueDate, billingPeriodStart, billingPeriodEnd,
    taxRate, notes, items, currencyCode, exchangeRate,
  } = req.body;
  if (!clientId) return apiResponse.badRequest(res, 'clientId is required');
  if (!items || !Array.isArray(items) || items.length === 0) return apiResponse.badRequest(res, 'items required');

  // Currency defaults
  const invCurrencyCode = (typeof currencyCode === 'string' && currencyCode.trim())
    ? currencyCode.trim().toUpperCase() : 'ZAR';
  const invExchangeRate = (typeof exchangeRate === 'number' && exchangeRate > 0) ? exchangeRate : 1.0;

  try {
    const userId = String(req.user?.id || 'system');

    // Calculate totals (in foreign currency)
    const rate = taxRate ?? 15;
    let subtotal = 0;
    for (const item of items) {
      subtotal += (item.quantity || 1) * item.unitPrice;
    }
    subtotal = Math.round(subtotal * 100) / 100;
    const taxAmount = Math.round(subtotal * (rate / 100) * 100) / 100;
    const totalAmount = subtotal + taxAmount;
    // functional_total = total in ZAR (functional currency)
    const functionalTotal = Math.round(totalAmount * invExchangeRate * 100) / 100;

    const today = new Date().toISOString().split('T')[0];
    const invDate = invoiceDate || today;
    const bpStart = billingPeriodStart || null;
    const bpEnd = billingPeriodEnd || null;

    // Find project from client (optional)
    let projectId: string | null = null;
    try {
      const projRows = (await sql`SELECT id FROM projects WHERE client_id = ${clientId}::UUID AND company_id = ${companyId} LIMIT 1`) as Row[];
      projectId = (projRows[0]?.['id'] as string | undefined) ?? null;
    } catch { /* projects table may not exist */ }

    // Reserve invoice number from the company's configured sequence.
    // The reservation is atomic — the only collision that can occur is with
    // a pre-existing invoice_number from before sequence-based generation
    // (e.g. legacy rows or a Sage import). On that residual clash, re-reserve.
    //
    // Trade-off: the reservation happens BEFORE the INSERT and is not rolled
    // back if the INSERT fails for any reason (FK violation, unique clash,
    // anything). Each failed attempt permanently burns one sequence slot.
    // Gaps are acceptable for accountancy purposes here — a user can resync
    // next_number from Settings → Document Numbers if they ever need to.
    // We accept this over wrapping in a transaction because a transactional
    // counter would serialize all invoice creates company-wide.
    let invoiceId = '';
    let invoiceNumber = await reserveNextDocumentNumber(companyId, 'customer_invoice');
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const invRows = (await sql`
          INSERT INTO customer_invoices (
            company_id, invoice_number, project_id, customer_id, client_id,
            billing_period_start, billing_period_end,
            subtotal, tax_rate, tax_amount, total_amount, invoice_date, due_date,
            notes, status, created_by,
            currency_code, exchange_rate, functional_total
          ) VALUES (
            ${companyId}, ${invoiceNumber}, ${projectId}, ${clientId}::UUID, ${clientId}::UUID,
            ${bpStart}, ${bpEnd},
            ${subtotal}, ${rate}, ${taxAmount}, ${totalAmount}, ${invDate},
            ${dueDate || null}, ${notes || null}, 'draft', ${userId},
            ${invCurrencyCode}, ${invExchangeRate}, ${functionalTotal}
          ) RETURNING id
        `) as Row[];
        invoiceId = String(invRows[0]!.id);
        break;
      } catch (insertErr) {
        const msg = insertErr instanceof Error ? insertErr.message : String(insertErr);
        if (msg.includes('unique') && attempt < 4) {
          invoiceNumber = await reserveNextDocumentNumber(companyId, 'customer_invoice');
          continue;
        }
        throw insertErr;
      }
    }

    for (const item of items) {
      const qty = item.quantity || 1;
      const lineAmount = Math.round(qty * item.unitPrice * 100) / 100;
      await sql`
        INSERT INTO customer_invoice_items (
          invoice_id, description, unit_price, quantity, amount, tax_rate, currency_code
        ) VALUES (
          ${invoiceId}::UUID, ${item.description}, ${item.unitPrice},
          ${qty}, ${lineAmount}, ${rate}, ${invCurrencyCode}
        )
      `;
    }

    log.info('Customer invoice created', { invoiceNumber, totalAmount, currencyCode: invCurrencyCode, exchangeRate: invExchangeRate });
    return apiResponse.created(res, { id: invoiceId, invoiceNumber });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Invoice create failed', { error: msg });
    const clientMessage = process.env.NODE_ENV === 'development' ? msg : 'Failed to create invoice';
    return res.status(500).json({ success: false, error: { code: 'CREATE_FAILED', message: clientMessage } });
  }
}


export default withAuth(
  withErrorHandler(
    withCsrf(
      withWriteAccess(
        withFlowMeter('invoice.create', getFlowCost('invoice.create'))(handler),
      ),
    ),
  ),
);
