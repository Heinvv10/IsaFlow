/**
 * GET /api/payroll/irp5/easyfile-export?taxYear=2026
 *
 * Produces a SARS e@syFile IRP5 import file (.irp5 CSV text) per BRS v25.2.
 *
 * Tax year 2026 = Mar 2025 – Feb 2026. Emits an annual (reconciliation
 * period MM=02) file, or with &period=interim the March–August one (MM=08,
 * wave 6 EFb). A filing goes through the EMP501 lifecycle
 * (/api/payroll/emp501/returns), which snapshots this input at finalise.
 *
 * Returns 422 with an explanation when the company is missing the
 * payroll-tax registration fields required by SARS.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { buildIrp5File, UsageError } from '@/modules/accounting/services/payroll/easyFileExportService';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';
import { assembleEasyFileInput, EasyFileInputRefusal } from '@/modules/accounting/services/payroll/easyFileInput';
import { respondIfRunKindUnsupported } from '@/lib/apiRunKindUnsupported';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  // Pentest M17: bound numeric query params — reject year 9999 / -1 / NaN.
  const taxYearRaw = req.query.taxYear ? Number(req.query.taxYear) : new Date().getFullYear();
  if (!Number.isInteger(taxYearRaw) || taxYearRaw < 2000 || taxYearRaw > 2100) {
    return apiResponse.badRequest(res, 'taxYear must be an integer between 2000 and 2100');
  }
  const taxYear = taxYearRaw;
  const periodRaw = req.query.period ?? 'annual';
  if (periodRaw !== 'annual' && periodRaw !== 'interim') {
    return apiResponse.badRequest(res, 'period must be annual or interim');
  }

  let input;
  try {
    input = await assembleEasyFileInput(companyId, taxYear, periodRaw);
  } catch (err) {
    if (respondIfRunKindUnsupported(res, err)) return;
    if (!(err instanceof EasyFileInputRefusal)) throw err;
    if (err.kind === 'not_found') return apiResponse.notFound(res, err.message);
    if (err.kind === 'bad_request') return apiResponse.badRequest(res, err.message);
    return apiResponse.error(res, 'VALIDATION_ERROR' as never, err.message, err.details);
  }
  const { employer, employees, payeRef, warnings, warningsTotal, unlinkedPaymentIds } = input;

  try {
    const fileBody = buildIrp5File({ employer, employees });
    const filename = `IRP5_${taxYear - 1}_${taxYear}_${payeRef}${periodRaw === 'interim' ? '_08' : ''}.irp5`;

    log.info('e@syFile IRP5 export generated', {
      companyId, taxYear, employees: employees.length, bytes: fileBody.length,
    }, 'easyFileExport');
    if (warnings.length > 0) {
      // Counts only in the log: the text names employees and is for the authorised caller.
      log.warn('e@syFile export warnings', {
        companyId, taxYear, warnings: warningsTotal, unlinkedPayments: unlinkedPaymentIds,
      }, 'easyFileExport');
      res.setHeader('X-IsaFlow-Warnings', encodeURIComponent(JSON.stringify(warnings)));
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).end(fileBody);
  } catch (err) {
    if (err instanceof UsageError) {
      return apiResponse.error(res, 'VALIDATION_ERROR' as never, err.message);
    }
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withPayrollDetailAccess(handler))));
