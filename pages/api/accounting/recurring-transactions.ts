/**
 * Recurring Transactions API — WS-8.4
 * GET    — list templates
 * POST   — create template
 * PUT    — update template (body includes id)
 * DELETE — delete template (?id=X)
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { isUuidParam } from '@/lib/validation';
import { APPROVE_MODULE_BY_DOCUMENT, approveRefusedMessage, mayApprove } from '@/modules/accounting/services/core/approvePermission';
import {
  getRecurringTemplates,
  createRecurringTemplate,
  updateRecurringTemplate,
  deleteRecurringTemplate,
} from '@/modules/accounting/services/core/recurringTransactionService';

/**
 * #1656: an autoPost template posts what it holds on every run: a journal (Chart of Accounts Approve), a customer invoice
 * (Customers & AR Approve) or a supplier invoice (Suppliers & AP Approve). A later run checks only the RUNNER's Approve, so
 * the person who writes the figures must hold the module's Approve too (#1670 Codex): only they may create such a template,
 * turn autoPost on, or edit one that has it on. A type with no module is refused (gate everything, fail closed).
 */
/**
 * The two fields the approve rule reads, typed before anything else (security review of #1670):
 * auto_post is a boolean column, and Postgres casts 'true' / '1' / 'yes' to true, so a string or a
 * number that slipped past a `=== true` test would be stored ON. Anything but a boolean is a 400.
 */
const FlagFields = z.object({
  entityType: z.enum(['journal_entry', 'customer_invoice', 'supplier_invoice']).optional(),
  autoPost: z.boolean().nullable().optional(),
}).passthrough();

const AUTO_POST_WHAT: Readonly<Record<string, string>> = { journal_entry: 'journals', customer_invoice: 'customer invoices', supplier_invoice: 'supplier invoices' };

/** The refusal when a template of this type with this autoPost would post for someone who may not approve it; null when it may go on. */
async function autoPostRefusal(companyId: string, userId: string, type: string, autoPost: unknown): Promise<string | null> {
  // Belt and braces: anything but an explicit false / absent counts as on, as the column would store it.
  if (autoPost === undefined || autoPost === null || autoPost === false) return null;
  const module = Object.prototype.hasOwnProperty.call(AUTO_POST_WHAT, type) ? APPROVE_MODULE_BY_DOCUMENT[type] : undefined;
  if (!module) return `An auto-posting template of type ${type} has no Approve permission to check, so it is refused.`;
  return (await mayApprove(companyId, userId, module)) ? null : approveRefusedMessage(module, AUTO_POST_WHAT[type]!);
}

/**
 * An update is judged on the STORED template (breaker R2-C): its entity type always (the update
 * service never changes it, so a body's entityType decides nothing), and its auto_post unless the
 * body sets one. null when this company has no such template. The row is locked FOR UPDATE in the
 * request transaction (withAuth) and held through the update (#1670 Codex): an approver who turns
 * auto_post on meanwhile is either seen here or waits for this edit, never lands between them.
 */
async function lockStoredTemplateFlags(companyId: string, id: string): Promise<{ type: string; autoPost: boolean } | null> {
  const rows = await sql`
    SELECT entity_type, auto_post FROM recurring_transaction_templates
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    FOR UPDATE
  ` as Array<{ entity_type: string; auto_post: boolean }>;
  return rows[0] ? { type: rows[0].entity_type, autoPost: rows[0].auto_post } : null;
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const items = await getRecurringTemplates(companyId);
    return apiResponse.success(res, items);
  }

  if (req.method === 'POST' || req.method === 'PUT') {
    const flags = FlagFields.safeParse(req.body ?? {});
    if (!flags.success) {
      return apiResponse.badRequest(res, 'entityType must be journal_entry, customer_invoice or supplier_invoice, and autoPost true or false');
    }
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
    const refused = await autoPostRefusal(companyId, userId, entityType, autoPost);
    if (refused) return apiResponse.forbidden(res, refused);
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
    if (!isUuidParam(id)) return apiResponse.notFound(res, 'Recurring template');
    const stored = await lockStoredTemplateFlags(companyId, id);
    if (!stored) return apiResponse.notFound(res, 'Recurring template');
    // Any edit of a template that will post (stored type; the body's autoPost, else the stored one).
    const refused = await autoPostRefusal(companyId, req.user.id, stored.type, updates.autoPost ?? stored.autoPost);
    if (refused) return apiResponse.forbidden(res, refused);
    delete updates.entityType; // never changed by the update (the service ignores it); not trusted either
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
