/**
 * PATCH /api/admin/payroll/sars-codes/[code]?taxYear=YYYY
 *
 * Body: { status: 'deprecated' | 'active' }
 *
 * Toggles a single code's status — used for emergency mid-year deprecation
 * after a SARS BRS interim release, or to restore a code marked deprecated
 * in error. Description / category are NOT editable; those come from the
 * SARS source file via re-import.
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';
import { deprecateCode, restoreCode } from '@/modules/admin/services/sarsCodesAdminService';

const Body = z.object({ status: z.enum(['deprecated', 'active']) }).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'PATCH') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['PATCH']);
  }

  const code = String(req.query.code ?? '').trim();
  if (!/^\d{4}$/.test(code)) {
    return apiResponse.badRequest(res, 'code must be a 4-digit SARS source code');
  }

  const taxYear = req.query.taxYear ? Number(req.query.taxYear) : NaN;
  if (!Number.isInteger(taxYear) || taxYear < 2000 || taxYear > 2100) {
    return apiResponse.badRequest(res, 'taxYear must be a valid year');
  }

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
  }

  try {
    if (parsed.data.status === 'deprecated') {
      await deprecateCode(code, taxYear);
    } else {
      await restoreCode(code, taxYear);
    }

    await logAdminAction(
      req.user.id,
      `sars_codes.${parsed.data.status === 'deprecated' ? 'deprecate' : 'restore'}`,
      'sars_source_code',
      `${code}@${taxYear}`,
      { code, tax_year: taxYear, status: parsed.data.status },
      getIp(req)
    );

    return apiResponse.success(res, { code, taxYear, status: parsed.data.status });
  } catch (err) {
    log.error('Failed to update SARS code status', { error: err, code, taxYear }, 'admin-api');
    return apiResponse.badRequestFromError(res, err, 'Failed');
  }
}

export default withAdmin(withCsrf(handler));
