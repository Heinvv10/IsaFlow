/**
 * Recurring Invoices Run API
 * POST — run one recurring invoice by ID, or all currently due
 * Body: { recurring_invoice_id?: string }
 * Returns: { generated: number; invoice_ids: string[]; errors: string[] }
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withCompany,
  withWriteAccess,
  type AuthenticatedNextApiRequest,
  type CompanyApiRequest,
} from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { generateInvoiceFromRecurring } from '@/modules/accounting/services/ar/recurringInvoiceService';
import type { DbRow } from '@/lib/neon';

interface RunResult {
  generated: number;
  invoice_ids: string[];
  errors: string[];
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyApiRequest;
  const userId = req.user.id;
  const { recurring_invoice_id } = req.body as { recurring_invoice_id?: string };

  const result: RunResult = { generated: 0, invoice_ids: [], errors: [] };

  if (recurring_invoice_id) {
    // Run a single recurring invoice
    try {
      const invoiceId = await generateInvoiceFromRecurring(companyId, recurring_invoice_id, userId);
      result.generated = 1;
      result.invoice_ids = [invoiceId];
      log.info('Single recurring invoice run', { recurring_invoice_id, invoiceId }, 'recurring-run');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to generate invoice';
      result.errors.push(`${recurring_invoice_id}: ${msg}`);
      log.error('Recurring invoice run failed', { recurring_invoice_id, error: err }, 'recurring-run');
    }
    return apiResponse.success(res, result);
  }

  // Run all due — next_run_date <= today, status = 'active'
  const dueRows = (await sql`
    SELECT id
    FROM recurring_invoices
    WHERE company_id = ${companyId}
      AND status = 'active'
      AND next_run_date <= CURRENT_DATE
    ORDER BY next_run_date ASC
  `) as DbRow[];

  if (dueRows.length === 0) {
    log.info('No due recurring invoices to run', { companyId }, 'recurring-run');
    return apiResponse.success(res, result);
  }

  for (const row of dueRows) {
    const id = String(row.id);
    try {
      const invoiceId = await generateInvoiceFromRecurring(companyId, id, userId);
      result.generated += 1;
      result.invoice_ids.push(invoiceId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to generate invoice';
      result.errors.push(`${id}: ${msg}`);
      log.error('Bulk recurring run — single item failed', { id, error: err }, 'recurring-run');
    }
  }

  log.info('Bulk recurring invoice run complete', {
    total: dueRows.length,
    generated: result.generated,
    errors: result.errors.length,
  }, 'recurring-run');

  return apiResponse.success(res, result);
}

export default withCompany(withErrorHandler(withWriteAccess(handler as never)));
