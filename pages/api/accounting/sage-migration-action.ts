/**
 * Sage Migration Actions API
 * POST /api/accounting/sage-migration-action
 *
 * Actions: auto_map, manual_map, import_ledger, import_invoices, compare, reset
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, withRole, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  autoMapAccounts,
  mapAccount,
  importLedgerTransactions,
  importSupplierInvoices,
  importCustomerInvoices,
  generateComparison,
  resetMigration,
} from '@/modules/accounting/services/sageMigrationService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || '', ['POST']);
  }

  const { companyId } = req as CompanyApiRequest;
  const userId = req.user.id;
  const { action } = req.body;

  if (!action) {
    return apiResponse.badRequest(res, 'action is required');
  }

  log.info(`Sage migration action: ${action}`, { userId }, 'accounting');

  switch (action) {
    case 'auto_map': {
      const run = await autoMapAccounts(companyId, userId);
      return apiResponse.success(res, run);
    }

    case 'manual_map': {
      const { sageAccountId, glAccountId, notes } = req.body;
      if (!sageAccountId) return apiResponse.badRequest(res, 'sageAccountId is required');
      await mapAccount(companyId, sageAccountId, glAccountId || null, notes);
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
      const { resetType, confirm } = req.body;
      if (!resetType || !['accounts', 'ledger', 'invoices', 'customer_invoices'].includes(resetType)) {
        return apiResponse.badRequest(res, 'resetType must be accounts, ledger, invoices, or customer_invoices');
      }
      if (confirm !== true) {
        return apiResponse.badRequest(res, 'Reset requires { confirm: true } to prevent accidental data loss');
      }
      log.warn('Sage migration reset initiated', {
        resetType,
        userId,
        timestamp: new Date().toISOString(),
      }, 'sage-migration');
      await resetMigration(companyId, resetType);
      return apiResponse.success(res, { reset: resetType });
    }

    default:
      return apiResponse.badRequest(res, `Unknown action: ${action}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withRole('admin')(withErrorHandler(handler as any)));
