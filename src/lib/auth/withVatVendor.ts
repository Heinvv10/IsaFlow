/**
 * Server-side VAT-vendor gate for VAT-only API routes.
 *
 * The UI hides VAT surfaces from companies that are not VAT vendors, but a
 * stale tab, a bookmark or a direct call would otherwise still generate and
 * persist VAT201 drafts, adjustments and DRC postings for a company whose own
 * settings say it does not file VAT. That is a data-integrity problem, not an
 * authorisation one — hence 403 with an explanatory message rather than a
 * silent empty result.
 *
 * Registration is read through `isVatRegistered` so this agrees with every
 * other consumer (see vatPeriodHelper): 'none' in EITHER `vat_period` or
 * `vat_system_type` means not a vendor.
 */

import type { NextApiHandler, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { isVatRegistered } from '@/modules/bureau/services/vatPeriodHelper';
import type { CompanyAuthedRequest } from './withAuth';

export type CompanyApiHandler = (req: CompanyAuthedRequest, res: NextApiResponse) => void | Promise<void>;

interface VatColumns {
  vat_period: string | null;
  vat_system_type: string | null;
}

/** True unless the company has explicitly opted out of VAT. Unknown id → false. */
export async function isCompanyVatVendor(companyId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT vat_period, vat_system_type FROM companies WHERE id = ${companyId}
  `) as unknown as VatColumns[];
  const row = rows[0];
  if (!row) return false;
  return isVatRegistered(row.vat_period, row.vat_system_type);
}

/**
 * Refuse the request with 403 when the authenticated company is not a VAT
 * vendor. Wrap OUTSIDE nothing in particular — it only needs `companyId`, so
 * it composes anywhere inside `withAuth`.
 */
export function withVatVendor<T extends NextApiHandler | CompanyApiHandler>(handler: T): T {
  return (async (req: Parameters<T>[0], res: NextApiResponse) => {
    const { companyId } = req as CompanyAuthedRequest;
    if (!(await isCompanyVatVendor(companyId))) {
      return apiResponse.forbidden(
        res,
        'This company is not registered for VAT. Set a VAT period in company settings first.',
      );
    }
    return (handler as NextApiHandler)(req, res);
  }) as T;
}
