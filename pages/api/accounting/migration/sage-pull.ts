/**
 * Sage Auto-Pull API
 * GET /api/accounting/migration/sage-pull?step=scripts
 *   → Returns JavaScript snippets the browser extension injects into Sage
 *
 * POST /api/accounting/migration/sage-pull
 *   → Receives raw Sage data from the browser, maps to ISAFlow format, returns mapped data
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest, withRole } from '@/lib/auth';
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
} from '@/modules/accounting/services/sageAutoImportService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    // Return the JS scripts the browser extension will inject into Sage
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
      case 'accounts': {
        const mapped = mapSageAccounts(data.Results || []);
        return apiResponse.success(res, {
          step: 'accounts',
          total: data.TotalResults || mapped.length,
          records: mapped,
        });
      }
      case 'customers': {
        const mapped = mapSageCustomers(data.Results || []);
        return apiResponse.success(res, {
          step: 'customers',
          total: data.TotalResults || mapped.length,
          records: mapped,
        });
      }
      case 'suppliers': {
        const mapped = mapSageSuppliers(data.Results || []);
        return apiResponse.success(res, {
          step: 'suppliers',
          total: data.TotalResults || mapped.length,
          records: mapped,
        });
      }
      case 'arInvoices': {
        const mapped = mapSageARInvoices(data.Results || []);
        return apiResponse.success(res, {
          step: 'arInvoices',
          total: data.TotalResults || mapped.length,
          records: mapped,
        });
      }
      case 'apInvoices': {
        const mapped = mapSageAPInvoices(data.Results || []);
        return apiResponse.success(res, {
          step: 'apInvoices',
          total: data.TotalResults || mapped.length,
          records: mapped,
        });
      }
      case 'company': {
        return apiResponse.success(res, {
          step: 'company',
          record: {
            name: data.Name,
            taxNumber: data.TaxNumber,
            registrationNumber: data.RegistrationNumber,
            currency: data.CurrencySymbol,
            takeOnDate: data.TakeOnBalanceDate,
          },
        });
      }
      default:
        return apiResponse.badRequest(res, `Unknown step: ${step}`);
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

// Super admin only — ISAFlow internal tool
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withRole('super_admin')(withErrorHandler(handler)) as any);
