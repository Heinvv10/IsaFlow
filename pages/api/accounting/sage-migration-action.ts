/**
 * Sage Migration Actions API
 * POST /api/accounting/sage-migration-action
 *
 * Actions: auto_map, manual_map, import_ledger, import_invoices, compare, reset
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withRole, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  autoMapAccounts,
  mapAccount,
  importLedgerTransactions,
  importSupplierInvoices,
  importCustomerInvoices,
  generateComparison,
  resetMigration,
} from '@/modules/accounting/services/core/sageMigrationService';

const SageMigrationActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('auto_map') }),
  z.object({
    action: z.literal('manual_map'),
    sageAccountId: z.string().min(1),
    glAccountId: z.string().optional(),
    notes: z.string().optional(),
  }),
  z.object({ action: z.literal('import_ledger') }),
  z.object({ action: z.literal('import_invoices') }),
  z.object({ action: z.literal('import_customer_invoices') }),
  z.object({ action: z.literal('compare') }),
  z.object({
    action: z.literal('reset'),
    resetType: z.enum(['accounts', 'ledger', 'invoices', 'customer_invoices']),
    confirm: z.literal(true),
  }),
]);

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || '', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const userId = req.user.id;

  const parsed = SageMigrationActionSchema.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
  }
  const body = parsed.data;

  log.info(`Sage migration action: ${body.action}`, { userId }, 'accounting');

  switch (body.action) {
    case 'auto_map': {
      const run = await autoMapAccounts(companyId, userId);
      return apiResponse.success(res, run);
    }

    case 'manual_map': {
      const { sageAccountId, glAccountId, notes } = body;
      await mapAccount(companyId, sageAccountId, glAccountId ?? null, notes);
      return apiResponse.success(res, { mapped: true });
    }

    case 'import_ledger': {
      const run = await importLedgerTransactions(companyId, userId);
      return apiResponse.success(res, run);
    }

    case 'import_invoices': {
      const run = await importSupplierInvoices(companyId, userId);
      return apiResponse.success(res, run);
    }

    case 'import_customer_invoices': {
      const run = await importCustomerInvoices(companyId, userId);
      return apiResponse.success(res, run);
    }

    case 'compare': {
      const report = await generateComparison(companyId, userId);
      return apiResponse.success(res, report);
    }

    case 'reset': {
      const { resetType } = body;
      log.warn('Sage migration reset initiated', {
        resetType,
        userId,
        timestamp: new Date().toISOString(),
      }, 'sage-migration');
      await resetMigration(companyId, resetType);
      return apiResponse.success(res, { reset: resetType });
    }
  }
}

 
export default withAuth(withRole('admin')(withErrorHandler(handler)));
