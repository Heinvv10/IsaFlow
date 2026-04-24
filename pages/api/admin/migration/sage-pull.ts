/**
 * Admin Sage Auto-Pull API
 *
 * GET  /api/admin/migration/sage-pull?companyId=<uuid>
 *   → Returns JS snippets the admin pastes / bookmarklets onto a Sage tab.
 *
 * POST /api/admin/migration/sage-pull?companyId=<uuid>
 *   → Receives raw Sage data, maps to ISAFlow format, returns mapped rows.
 *
 * Staff-only. Uses withAdmin (= withPlatformAdmin + CSRF + error handler),
 * which reads public.users.role under BYPASSRLS and 403s non-super-admins.
 *
 * Target tenant is chosen per-request via the `companyId` query param, not
 * from the active cookie — admins operate across tenants.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { log } from '@/lib/logger';
import {
  buildSageAccountsFetchScript,
  buildSageFetchScript,
  buildSageCompanyFetchScript,
  mapSageAccounts,
  mapSageCustomers,
  mapSageSuppliers,
  mapSageARInvoices,
  mapSageAPInvoices,
} from '@/modules/accounting/services/core/sageAutoImportService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const companyId = typeof req.query.companyId === 'string'
    ? req.query.companyId
    : (typeof req.body?.companyId === 'string' ? req.body.companyId : null);

  if (!companyId) {
    return apiResponse.validationError(res, { companyId: 'companyId is required' });
  }

  if (req.method === 'GET') {
    const scripts = {
      company: buildSageCompanyFetchScript(),
      accounts: buildSageAccountsFetchScript(),
      customers: buildSageFetchScript('/services/Customer/GetWithFilter', 200),
      suppliers: buildSageFetchScript('/services/Supplier/GetWithFilter', 200),
      arInvoices: buildSageFetchScript('/services/TaxInvoice/GetWithFilter', 200),
      apInvoices: buildSageFetchScript('/services/SupplierInvoice/GetWithFilter', 200),
    };
    return apiResponse.success(res, { scripts });
  }

  if (req.method === 'POST') {
    const { step, rawData } = req.body as { step: string; rawData: unknown };

    if (!step || !rawData) {
      return apiResponse.validationError(res, { step: 'step and rawData are required' });
    }

    log.info('Sage auto-pull received', { companyId, step }, 'migration');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = rawData as any;

    switch (step) {
      case 'accounts':
        return apiResponse.success(res, {
          step, total: data.TotalResults || (data.Results || []).length,
          records: mapSageAccounts(data.Results || []),
        });
      case 'customers':
        return apiResponse.success(res, {
          step, total: data.TotalResults || (data.Results || []).length,
          records: mapSageCustomers(data.Results || []),
        });
      case 'suppliers':
        return apiResponse.success(res, {
          step, total: data.TotalResults || (data.Results || []).length,
          records: mapSageSuppliers(data.Results || []),
        });
      case 'arInvoices':
        return apiResponse.success(res, {
          step, total: data.TotalResults || (data.Results || []).length,
          records: mapSageARInvoices(data.Results || []),
        });
      case 'apInvoices':
        return apiResponse.success(res, {
          step, total: data.TotalResults || (data.Results || []).length,
          records: mapSageAPInvoices(data.Results || []),
        });
      case 'company':
        return apiResponse.success(res, {
          step,
          record: {
            name: data.Name,
            taxNumber: data.TaxNumber,
            registrationNumber: data.RegistrationNumber,
            currency: data.CurrencySymbol,
            takeOnDate: data.TakeOnBalanceDate,
          },
        });
      default:
        return apiResponse.badRequest(res, `Unknown step: ${step}`);
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

export default withAdmin(handler);
