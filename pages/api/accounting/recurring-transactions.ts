/**
 * Recurring Transactions API — WS-8.4
 * GET    — list templates
 * POST   — create template
 * PUT    — update template (body includes id)
 * DELETE — delete template (?id=X)
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { isUuidParam } from '@/lib/validation';
import { SUPPLIER_INVOICE_APPROVE_REFUSED, mayApproveSupplierInvoices } from '@/modules/accounting/services/ap/billApprovePermission';
import {
  getRecurringTemplates,
  createRecurringTemplate,
  updateRecurringTemplate,
  deleteRecurringTemplate,
} from '@/modules/accounting/services/core/recurringTransactionService';

/**
 * #1656: an autoPost supplier-invoice template approves a bill on every run, so only a person who
 * may approve supplier invoices (Suppliers & AP Approve) may create one or turn autoPost on. A run
 * by someone without it leaves the bill a draft (mintRecurringSupplierInvoice).
 */
async function refusesAutoPostBills(
  companyId: string, userId: string, entityType: unknown, autoPost: unknown, templateId?: string,
): Promise<boolean> {
  let type = entityType;
  let post = autoPost;
  // A malformed id names no template: left to the update service, which answers it as before.
  if (templateId && isUuidParam(templateId) && (type === undefined || post === undefined)) {
    const rows = await sql`
      SELECT entity_type, auto_post FROM recurring_transaction_templates
      WHERE id = ${templateId}::UUID AND company_id = ${companyId}::UUID
    ` as Array<{ entity_type: string; auto_post: boolean }>;
    type ??= rows[0]?.entity_type;
    post ??= rows[0]?.auto_post;
  }
  if (type !== 'supplier_invoice' || post !== true) return false;
  return !(await mayApproveSupplierInvoices(companyId, userId));
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const items = await getRecurringTemplates(companyId);
    return apiResponse.success(res, items);
  }

  if (req.method === 'POST') {
    const { name, entityType, templateData, frequency, nextRunDate, isActive, autoPost } = req.body as {
      name?: string;
      entityType?: string;
      templateData?: Record<string, unknown>;
      frequency?: string;
      nextRunDate?: string;
      isActive?: boolean;
      autoPost?: boolean;
    };
    if (!name || !entityType || !templateData || !frequency) {
      return apiResponse.badRequest(res, 'name, entityType, templateData, and frequency are required');
    }
    const userId = req.user.id;
    if (await refusesAutoPostBills(companyId, userId, entityType, autoPost)) {
      return apiResponse.forbidden(res, SUPPLIER_INVOICE_APPROVE_REFUSED);
    }
    try {
      const item = await createRecurringTemplate(companyId, userId, {
        name,
        entityType: entityType as Parameters<typeof createRecurringTemplate>[2]['entityType'],
        templateData,
        frequency: frequency as Parameters<typeof createRecurringTemplate>[2]['frequency'],
        nextRunDate,
        isActive,
        autoPost,
      });
      return apiResponse.success(res, item);
    } catch (err) {
      if (respondIfLockTimeout(res, err)) return;
      log.error('Recurring template create failed', { error: err }, 'recurring-api');
      return apiResponse.badRequestFromError(res, err, 'Create failed');
    }
  }

  if (req.method === 'PUT') {
    const { id, ...updates } = req.body as { id?: string; [key: string]: unknown };
    if (!id) return apiResponse.badRequest(res, 'id is required');
    // Only a change that touches either field can newly make the template approve bills.
    if ((updates.autoPost !== undefined || updates.entityType !== undefined)
      && await refusesAutoPostBills(companyId, req.user.id, updates.entityType, updates.autoPost, id)) {
      return apiResponse.forbidden(res, SUPPLIER_INVOICE_APPROVE_REFUSED);
    }
    try {
      const item = await updateRecurringTemplate(
        companyId, id,
        updates as Parameters<typeof updateRecurringTemplate>[2],
        req.user.id,
      );
      return apiResponse.success(res, item);
    } catch (err) {
      if (respondIfLockTimeout(res, err)) return;
      log.error('Recurring template update failed', { error: err }, 'recurring-api');
      return apiResponse.badRequestFromError(res, err, 'Update failed');
    }
  }

  if (req.method === 'DELETE') {
    const id = req.query.id as string;
    if (!id) return apiResponse.badRequest(res, 'id query param is required');
    try {
      await deleteRecurringTemplate(companyId, id);
      return apiResponse.success(res, { deleted: true });
    } catch (err) {
      if (respondIfLockTimeout(res, err)) return;
      log.error('Recurring template delete failed', { error: err }, 'recurring-api');
      return apiResponse.badRequestFromError(res, err, 'Delete failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST', 'PUT', 'DELETE']);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
