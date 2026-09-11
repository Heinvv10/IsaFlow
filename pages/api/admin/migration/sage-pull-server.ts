/**
 * Admin Sage Server-Side Pull API
 *
 * POST /api/admin/migration/sage-pull-server
 *
 * Body: {
 *   companyId: string,
 *   sageCookie: string,             // raw `Cookie:` header value — name=value; name=value; …
 *                                   // (we send every cookie set by sageone.co.za, not just one)
 *   sageBase?: string,              // override host (default https://accounting.sageone.co.za)
 * }
 *
 * Pulls all six Sage endpoints server-to-server using the supplied
 * authenticated session cookie, maps them, and returns a payload shaped
 * like the existing in-browser pulled-data structure so it can be passed
 * straight into /api/admin/migration/sage-commit.
 *
 * Why server-side: cross-origin restrictions and HttpOnly cookies make
 * it impossible to do this fully in the browser without either a
 * bookmarklet or an extension. With the cookie obtained out-of-band
 * (extension or admin paste), the server can request the data directly.
 *
 * Staff-only via withAdmin.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { log } from '@/lib/logger';
import { safeFetch, checkPublicUrl } from '@/lib/safeFetch';
import {
  mapSageAccounts,
  mapSageCustomers,
  mapSageSuppliers,
  mapSageARInvoices,
  mapSageAPInvoices,
} from '@/modules/accounting/services/core/sageAutoImportService';
import { DEFAULT_SAGE_BASE, SAGE_ALLOWED_HOSTS, buildSageHeaders } from '@/modules/admin/services/sageSession';

const PAGE_SIZE = 200;

interface SageEnvelope { Results?: unknown[]; TotalResults?: number; }
interface CompanyResp { Name?: string; TaxNumber?: string; RegistrationNumber?: string; CurrencySymbol?: string; TakeOnBalanceDate?: string; }

async function pullEndpoint(
  base: string,
  cookie: string,
  endpoint: string,
  bodyExtras: Record<string, unknown> = {},
): Promise<SageEnvelope> {
  const allResults: unknown[] = [];
  let skip = 0;
  let total = Infinity;
  while (skip < total) {
    const res = await safeFetch(`${base}${endpoint}`, {
      method: 'POST',
      headers: buildSageHeaders(cookie),
      body: JSON.stringify({ FilterId: 0, Search: '', Skip: skip, Take: PAGE_SIZE, ...bodyExtras }),
    }, { allowHosts: SAGE_ALLOWED_HOSTS });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${endpoint} failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as SageEnvelope;
    total = json.TotalResults ?? 0;
    allResults.push(...(json.Results ?? []));
    skip += PAGE_SIZE;
    if ((json.Results ?? []).length < PAGE_SIZE) break;
  }
  return { Results: allResults, TotalResults: allResults.length };
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId, sageCookie, sageBase } = (req.body ?? {}) as {
    companyId?: string; sageCookie?: string; sageBase?: string;
  };
  if (!companyId) return apiResponse.validationError(res, { companyId: 'companyId is required' });
  if (!sageCookie || sageCookie.length < 16) {
    return apiResponse.validationError(res, { sageCookie: 'sageCookie is required' });
  }
  const base = (sageBase || DEFAULT_SAGE_BASE).replace(/\/+$/, '');

  // M5: reject a non-Sage / private / non-https base before any cookie is sent.
  const baseReason = await checkPublicUrl(base, { allowHosts: SAGE_ALLOWED_HOSTS });
  if (baseReason) {
    return apiResponse.badRequest(res, `sageBase must be a Sage HTTPS host (${baseReason})`);
  }

  log.info('Sage server-side pull starting', { companyId, base }, 'migration');

  try {
    const companyRes = await safeFetch(`${base}/services/Company/Current`, {
      headers: buildSageHeaders(sageCookie),
    }, { allowHosts: SAGE_ALLOWED_HOSTS });
    if (!companyRes.ok) {
      const status = companyRes.status;
      const text = await companyRes.text().catch(() => '');
      if (status === 401 || status === 403 || /sign in/i.test(text)) {
        return apiResponse.badRequest(res, 'Sage session cookie rejected (expired or wrong company). Reconnect and try again.');
      }
      return apiResponse.badRequest(res, `Sage company fetch failed: ${status}`);
    }
    const company = (await companyRes.json()) as CompanyResp;

    const [accountsRaw, customersRaw, suppliersRaw, arRaw, apRaw] = await Promise.all([
      pullEndpoint(base, sageCookie, '/services/Account/GetWithFilter', {
        FilterId: 2,
        OrderBy: 'AccountCategory_Order asc, Account_Type DESC, Account_Name Asc',
      }),
      pullEndpoint(base, sageCookie, '/services/Customer/GetWithFilter'),
      pullEndpoint(base, sageCookie, '/services/Supplier/GetWithFilter'),
      pullEndpoint(base, sageCookie, '/services/TaxInvoice/GetWithFilter'),
      pullEndpoint(base, sageCookie, '/services/SupplierInvoice/GetWithFilter'),
    ]);

    const pulled = {
      company: {
        step: 'company',
        record: {
          name: company.Name,
          taxNumber: company.TaxNumber,
          registrationNumber: company.RegistrationNumber,
          currency: company.CurrencySymbol,
          takeOnDate: company.TakeOnBalanceDate,
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      accounts:   { step: 'accounts',   total: accountsRaw.TotalResults,  records: mapSageAccounts((accountsRaw.Results ?? []) as any) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      customers:  { step: 'customers',  total: customersRaw.TotalResults, records: mapSageCustomers((customersRaw.Results ?? []) as any) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      suppliers:  { step: 'suppliers',  total: suppliersRaw.TotalResults, records: mapSageSuppliers((suppliersRaw.Results ?? []) as any) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      arInvoices: { step: 'arInvoices', total: arRaw.TotalResults,        records: mapSageARInvoices((arRaw.Results ?? []) as any) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      apInvoices: { step: 'apInvoices', total: apRaw.TotalResults,        records: mapSageAPInvoices((apRaw.Results ?? []) as any) },
    };

    log.info('Sage server-side pull complete', {
      companyId,
      counts: {
        accounts: pulled.accounts.total,
        customers: pulled.customers.total,
        suppliers: pulled.suppliers.total,
        arInvoices: pulled.arInvoices.total,
        apInvoices: pulled.apInvoices.total,
      },
    }, 'migration');

    return apiResponse.success(res, { pulled });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Sage server-side pull failed', { companyId, message: msg }, 'migration');
    return apiResponse.badRequest(res, `Sage pull failed: ${msg}`);
  }
}

import { withCsrf } from '@/lib/auth/withCsrf';
export default withAdmin(withCsrf(handler));
